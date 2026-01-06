import Order from "../models/order.js";
import chatbotController from "./chatbotController.js";
import { messages } from "../config/messageHelper.js";
import mongoose from "mongoose";
import { paymentStatus } from "../config/paymentStatus.js";
import { orderStatus } from "../config/orderStatus.js";
import { addOrderToReport } from "../controllers/statisticController.js";
import asyncHandler from "../middlewares/asyncHandler.js";
import sendDeliveryInfo from "../utils/sendDeliveryInfo.js";
import Product from "../models/product.js";
import ProductVariant from "../models/productVariant.js";
import logger from "../utils/logger.js";
import axios from "axios";
import crypto from "crypto";
import moment from "moment";
import {
  PaymentContext,
  MoMoPaymentStrategy,
  VnPayPaymentStrategy,
  ZaloPayPaymentStrategy,
} from "../services/paymentService.js";
import { OrderStatusContextFactory } from "../services/statusService.js";

const getAllOrders = asyncHandler(async (req, res, next) => {
  const query = {};

  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const skip = (page - 1) * limit;

  if (req.query.paymentMethod) query.paymentMethod = req.query.paymentMethod;
  if (req.query.paymentStatus) query.paymentStatus = req.query.paymentStatus;

  const basePipeline = [
    { $match: query },
    {
      $lookup: {
        from: "users",
        localField: "userId",
        foreignField: "_id",
        as: "userInfo",
      },
    },
    { $unwind: "$userInfo" },
  ];

  if (req.query.search) {
    basePipeline.push({
      $match: {
        "userInfo.fullName": { $regex: req.query.search, $options: "i" },
      },
    });
  }

  if (req.query.status) {
    basePipeline.push(
      {
        $addFields: {
          lastStatus: {
            $let: {
              vars: {
                lastDelivery: {
                  $arrayElemAt: ["$deliveryInfo", -1],
                },
              },
              in: "$$lastDelivery.status",
            },
          },
        },
      },
      {
        $match: {
          lastStatus: { $regex: `^${req.query.status}$`, $options: "i" },
        },
      }
    );
  }

  const totalCountPipeline = [...basePipeline, { $count: "count" }];

  const pipeline = [
    ...basePipeline,
    { $skip: skip },
    { $limit: limit },
    {
      $project: {
        status: 1,
        paymentMethod: 1,
        paymentStatus: 1,
        "userInfo.fullName": 1,
        deliveryInfo: 1,
        finalPrice: 1,
        createdAt: 1,
      },
    },
  ];

  const totalResult = await Order.aggregate(totalCountPipeline);
  const totalCount = totalResult[0]?.count || 0;
  const orders = await Order.aggregate(pipeline);

  logger.info("Lấy danh sách đơn hàng thành công!", { ...query, page, limit });
  res.status(200).json({
    meta: {
      totalCount: totalCount,
      currentPage: page,
      totalPages: Math.ceil(totalCount / limit),
    },
    data: orders,
  });
});

const getAllOrdersByUserId = asyncHandler(async (req, res, next) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const skip = (page - 1) * limit;

  const userId = req.user.id;

  const totalCount = await Order.countDocuments({ userId: userId });
  const orders = await Order.find(
    { userId: userId },
    {
      paymentMethod: 1,
      finalPrice: 1,
      expectedDeliveryDate: 1,
      orderItems: 1,
      paymentStatus: 1,
      deliveryInfo: 1,
      userAddressId: 1,
    }
  )
    .skip(skip)
    .limit(limit)
    .exec();

  logger.info("Lấy danh sách đơn hàng thành công!", { userId, page, limit });
  return res.status(200).json({
    meta: {
      totalCount: totalCount,
      currentPage: page,
      totalPages: Math.ceil(totalCount / limit),
    },
    data: orders,
  });
});

const getOrderById = asyncHandler(async (req, res, next) => {
  const pipeline = [
    { $match: { _id: new mongoose.Types.ObjectId(req.params.id) } },
    {
      $lookup: {
        from: "users",
        localField: "userId",
        foreignField: "_id",
        as: "userInfo",
      },
    },
    { $unwind: "$userInfo" },
  ];

  pipeline.push({
    $project: {
      orderItems: 1,
      status: 1,
      paymentMethod: 1,
      paymentStatus: 1,
      "userInfo.fullName": 1,
      "userInfo.email": 1,
      deliveryInfo: 1,
      finalPrice: 1,
      createdAt: 1,
      shippingFee: 1,
      expectedDeliveryDate: 1,
      userAddressId: 1,
    },
  });

  const order = await Order.aggregate(pipeline);

  if (!order) {
    logger.warn("Đơn hàng không tồn tại");
    return res.status(404).json({ error: "Not found" });
  }

  logger.info("Lấy đơn hàng thành công");
  res.status(200).json({ data: order });
});

const createOrder = asyncHandler(async (req, res, next) => {
  const {
    orderItems,
    discount,
    userAddressId,
    shippingFee,
    paymentMethod,
    deliveryInfo,
    expectedDeliveryDate,
  } = req.body;

  const userId = req.user.id;

  if (
    !orderItems ||
    orderItems.length === 0 ||
    !userAddressId ||
    !paymentMethod
  ) {
    logger.warn(messages.MSG1);
    throw new Error(messages.MSG1);
  }

  const totalPrice = orderItems.reduce((acc, item) => {
    return acc + item.price * item.quantity;
  }, 0);

  const finalPrice = totalPrice - (totalPrice * discount) / 100 + shippingFee;

  const newOrder = new Order({
    userId,
    orderItems,
    totalPrice,
    discount,
    finalPrice,
    userAddressId,
    shippingFee,
    paymentMethod,
    deliveryInfo,
    expectedDeliveryDate,
  });

  chatbotController.updateEntityOrderId(newOrder._id);
  logger.info(messages.MSG19);
  await newOrder.save();
  res.status(201).json({ message: messages.MSG19, data: newOrder });
});

const updateDeliveryInfoById = asyncHandler(async (req, res, next) => {
  const orderId = req.params.id;
  const { status, deliveryAddress, expectedDeliveryDate } = req.body;
  const order = await Order.findById(orderId);

  if (!order) {
    logger.warn("Đơn hàng không tồn tại");
    return res.status(404).json({ error: "Not found" });
  }

  order.expectedDeliveryDate =
    expectedDeliveryDate || order.expectedDeliveryDate;

  if (!status || !deliveryAddress) {
    logger.warn(messages.MSG1);
    throw new Error(messages.MSG1);
  }

  try {
    // Sử dụng State Pattern để quản lý trạng thái
    const statusContext = await OrderStatusContextFactory.create(
      orderId,
      req.redisClient
    );

    // Kiểm tra xem có thể chuyển sang trạng thái mới không
    if (!statusContext.canTransitionTo(status)) {
      const currentStatus = statusContext.getCurrentStatus();
      logger.warn(`Không thể chuyển từ trạng thái "${currentStatus}" sang "${status}"`);
      return res.status(400).json({
        error: `Không thể chuyển từ trạng thái "${currentStatus}" sang "${status}"`,
      });
    }

    // Thực hiện chuyển trạng thái
    await statusContext.transitionTo(status, deliveryAddress);

    // Cập nhật expectedDeliveryDate nếu có
    if (expectedDeliveryDate) {
      order.expectedDeliveryDate = expectedDeliveryDate;
      await order.save();
    }

    logger.info(messages.MSG44);
    const updatedOrder = await Order.findById(orderId);
    res.status(200).json({ message: messages.MSG44, data: updatedOrder });
  } catch (error) {
    logger.error("Lỗi khi cập nhật trạng thái đơn hàng:", error);
    res.status(400).json({ error: error.message });
  }
});

const updatePaymentStatusById = asyncHandler(async (req, res, next) => {
  const orderId = req.params.id;
  const { paymentStatus } = req.body;
  const order = await Order.findById(orderId);

  if (!order) {
    logger.warn("Đơn hàng không tồn tại");
    return res.status(404).json({ error: "Not found" });
  }

  order.paymentStatus = paymentStatus;
  logger.info(messages.MSG40);
  await order.save();
  res.status(200).json({ message: messages.MSG40, data: order });
});

const checkoutWithMoMo = asyncHandler(async (req, res, next) => {
  const { orderId, amount } = req.body;

  if (!orderId || !amount) {
    logger.warn(messages.MSG1);
    return res.status(400).json({ message: messages.MSG1 });
  }

  const context = new PaymentContext();
  const strategy = new MoMoPaymentStrategy();
  context.setStrategy(strategy);

  try {
    const result = await context.checkout(orderId, amount);
    logger.info("Bắt đầu quá trình thanh toán Momo");
    res.status(200).json(result);
  } catch (error) {
    logger.error(messages.MSG5, error);
    res.status(500).json({ message: messages.MSG5 });
  }
});

const callbackMoMo = asyncHandler(async (req, res, next) => {
  const { resultCode, orderId } = req.body;

  if (resultCode === 0) {
    const context = new PaymentContext();
    const strategy = new MoMoPaymentStrategy();
    strategy.setOrderId(orderId);
    strategy.setResultCode(resultCode);
    context.setStrategy(strategy);

    try {
      await context.callback();
      res.status(200).json({ message: "Payment successful" });
    } catch (error) {
      logger.error("Lỗi callback Momo", error);
      res.status(500).json({ message: messages.MSG5 });
    }
  } else {
    logger.warn("Thanh toán Momo thất bại!");
    res.status(400).json({ message: "Payment failed" });
  }
});

const checkStatusTransaction = asyncHandler(async (req, res, next) => {
  const accessKey = "F8BBA842ECF85";
  const secretKey = "K951B6PE1waDMi640xX08PD3vg6EkVlz";
  const orderId = req.body.orderId;
  const partnerCode = "MOMO";

  const rawSignature = `accessKey=${accessKey}&orderId=${orderId}&partnerCode=${partnerCode}&requestId=${orderId}`;

  const signature = crypto
    .createHmac("sha256", secretKey)
    .update(rawSignature)
    .digest("hex");

  const requestBody = JSON.stringify({
    partnerCode: "MOMO",
    requestId: orderId,
    orderId: orderId,
    signature: signature,
    lang: "vi",
  });

  const options = {
    method: "POST",
    url: "https://test-payment.momo.vn/v2/gateway/api/query",
    headers: {
      "Content-Type": "application/json",
    },
    data: requestBody,
  };

  const response = await axios(options);

  if (response.data.resultCode === 0) {
    const order = await Order.findById({ _id: req.body.orderId });

    if (!order) {
      logger.warn("Đơn hàng không tồn tại");
      return res.status(404).json();
    }

    order.paymentStatus = paymentStatus.PAID;
    logger.info("Thanh toán đơn hàng thành công!");
    order.save();
    return res.status(200).json();
  } else {
    logger.info("Thanh toán đơn hàng thất bại!");
    return res.status(200).json();
  }
});

const sendMailDeliveryInfo = asyncHandler(async (req, res, next) => {
  const { orderId, email } = req.body;
  const order = await Order.findById(orderId);

  if (!order) {
    logger.warn("Đơn hàng không tồn tại");
    throw new Error("Not found");
  }

  await sendDeliveryInfo(email, order);
  logger.info("Gửi email thông báo trạng thái đơn hàng thành công!");
  res.status(200).json({ message: messages.MSG66 });
});

const checkoutWithVnPay = asyncHandler(async (req, res, next) => {
  const { orderId, amount, bankCode } = req.body;

  if (!orderId || !amount) {
    logger.warn(messages.MSG1);
    return res.status(400).json({ error: messages.MSG1 });
  }

  const ipAddr =
    req.headers["x-forwarded-for"] ||
    req.connection.remoteAddress ||
    req.socket.remoteAddress ||
    req.connection.socket.remoteAddress;

  const context = new PaymentContext();
  const strategy = new VnPayPaymentStrategy();
  strategy.setIpAddr(ipAddr);
  if (bankCode) {
    strategy.setBankCode(bankCode);
  }
  context.setStrategy(strategy);

  try {
    const url = await context.checkout(orderId, amount);
    logger.info("Gửi url thanh toán VnPay thành công!");
    res.status(200).json({ url });
  } catch (error) {
    logger.error("Lỗi thanh toán VnPay", error);
    res.status(500).json({ message: messages.MSG5 });
  }
});

const callbackVnPay = asyncHandler(async (req, res, next) => {
  const vnpParams = req.query;

  const context = new PaymentContext();
  const strategy = new VnPayPaymentStrategy();
  strategy.setQuery(vnpParams);
  context.setStrategy(strategy);

  try {
    const url = await context.callback();
    logger.info("Thanh toán VnPay thành công!");
    return res.redirect(url);
  } catch (error) {
    logger.error("Lỗi callback VnPay", error);

    if (error.message === "Not found") {
      return res.status(404).json({ error: "Not found" });
    }

    if (error.message === "Đơn hàng đã được thanh toán") {
      return res.status(400).json({ message: "Đơn hàng đã được thanh toán" });
    }

    if (error.message === "Số tiền thanh toán không khớp") {
      return res.status(400).json({ message: "Số tiền thanh toán không khớp" });
    }

    logger.warn("Thanh toán VnPay thất bại!");
    return res.status(400).json({ message: "Thanh toán thất bại!" });
  }
});

const checkoutWithZaloPay = asyncHandler(async (req, res, next) => {
  const app_id = "2553";
  const key1 = "PcY4iZIKFCIdgZvA6ueMcMHHUbRLYjPL";
  const endpoint = "https://sb-openapi.zalopay.vn/v2/create";
  const orderId = req.body.orderId;

  const embed_data = {
    redirectUrl: `${process.env.URL_CLIENT}/orderCompleted`,
  };
  const order = await Order.findById(orderId);
  if (!order) {
    logger.warn("Đơn hàng không tồn tại");
    return res.status(404).json({ message: "Đơn hàng không tồn tại" });
  }
  const amount = req.body.amount;

  let zaloPayParams = {
    app_id: app_id,
    app_trans_id: `${new Date()
      .toISOString()
      .slice(2, 10)
      .replace(/-/g, "")}_${orderId}`,
    app_user: "FashionSpace",
    app_time: Date.now(),
    item: JSON.stringify(order.orderItems),
    embed_data: JSON.stringify(embed_data),
    amount: amount,
    callback_url: `${process.env.LINK_NGROK}/api/v1/order/callbackZaloPay`,
    description: `Thanh toán đơn hàng ${orderId}`,
    bank_code: "",
  };

  const data =
    zaloPayParams.app_id +
    "|" +
    zaloPayParams.app_trans_id +
    "|" +
    zaloPayParams.app_user +
    "|" +
    zaloPayParams.amount +
    "|" +
    zaloPayParams.app_time +
    "|" +
    zaloPayParams.embed_data +
    "|" +
    zaloPayParams.item;

  zaloPayParams["mac"] = crypto
    .createHmac("sha256", key1)
    .update(data)
    .digest("hex");

  const result = await axios.post(endpoint, null, { params: zaloPayParams });
  return res.status(200).json(result.data);
});

const callbackZaloPay = asyncHandler(async (req, res, next) => {
  const key2 = "kLtgPl8HHhfvMuDHPwKfgfsY4Ydm9eIz";
  const { app_trans_id, amount } = JSON.parse(req.body.data);
  const mac = req.body.mac;

  const raw = req.body.data;
  const orderId = app_trans_id.split("_")[1];
  const order = await Order.findById(orderId);
  if (!order) {
    logger.warn("Đơn hàng không tồn tại");
    throw new Error("Not found");
  }

  const expected = crypto.createHmac("sha256", key2).update(raw).digest("hex");

  if (expected !== mac) {
    logger.warn("Mã xác thực không hợp lệ!");
    throw new Error("Mã xác thực không hợp lệ!");
  }

  if (order.paymentStatus === paymentStatus.PAID) {
    logger.warn("Đơn hàng đã được thanh toán trước đó");
    return;
  }

  if (order.finalPrice !== amount) {
    logger.warn("Số tiền thanh toán không khớp với đơn hàng");
    throw new Error("Số tiền thanh toán không khớp");
  }

  order.paymentStatus = paymentStatus.PAID;
  await order.save();
  logger.info("Thanh toán ZaloPay thành công!");
});

const checkStatusTransactionZaloPay = asyncHandler(async (req, res, next) => {
  const app_id = "2553";
  const key1 = "PcY4iZIKFCIdgZvA6ueMcMHHUbRLYjPL";
  const endpoint = "https://sb-openapi.zalopay.vn/v2/query";

  const { app_trans_id } = req.body;

  const data = `${app_id}|${app_trans_id}|${key1}`;
  const mac = crypto.createHmac("sha256", key1).update(data).digest("hex");

  const params = {
    app_id,
    app_trans_id,
    mac,
  };

  const result = await axios.post(endpoint, null, { params });

  if (result.data.return_code !== 1) {
    logger.warn("Truy vấn giao dịch thất bại!");
    return res.status(400).json({ message: "Truy vấn giao dịch thất bại!" });
  }

  if (result.data.return_code === 1) {
    const orderId = app_trans_id.split("_")[1];
    const order = await Order.findById(orderId);

    if (!order) {
      logger.warn("Đơn hàng không tồn tại");
      return res.status(404).json({ message: "Đơn hàng không tồn tại" });
    }

    if (order.paymentStatus === paymentStatus.PAID) {
      logger.warn("Đơn hàng đã được thanh toán trước đó");
      return res
        .status(400)
        .json({ message: "Đơn hàng đã được thanh toán trước đó" });
    }

    order.paymentStatus = paymentStatus.PAID;
    await order.save();
    logger.info("Thanh toán ZaloPay thành công!");
    return res.status(200).json({ message: "Thanh toán thành công!" });
  }
});

// Hàm mới: Chuyển đơn hàng sang trạng thái tiếp theo (sử dụng State Pattern)
const nextOrderStatus = asyncHandler(async (req, res, next) => {
  const orderId = req.params.id;
  const { deliveryAddress } = req.body;

  try {
    const statusContext = await OrderStatusContextFactory.create(
      orderId,
      req.redisClient
    );

    const newStatus = await statusContext.next(deliveryAddress);

    logger.info(`Đơn hàng ${orderId} đã chuyển sang trạng thái: ${newStatus}`);
    const updatedOrder = await Order.findById(orderId);
    res.status(200).json({
      message: `Đã chuyển sang trạng thái: ${newStatus}`,
      data: updatedOrder,
    });
  } catch (error) {
    logger.error("Lỗi khi chuyển trạng thái tiếp theo:", error);
    res.status(400).json({ error: error.message });
  }
});

// Hàm mới: Hủy đơn hàng (sử dụng State Pattern)
const cancelOrder = asyncHandler(async (req, res, next) => {
  const orderId = req.params.id;
  const { cancelBy, deliveryAddress } = req.body;

  // Kiểm tra quyền: Customer chỉ có thể hủy đơn hàng của mình
  const order = await Order.findById(orderId);
  if (!order) {
    logger.warn("Đơn hàng không tồn tại");
    return res.status(404).json({ error: "Đơn hàng không tồn tại" });
  }

  // Kiểm tra quyền hủy
  const userRole = req.user.role;
  if (cancelBy === "employee" && !["Admin", "Employee"].includes(userRole)) {
    return res.status(403).json({ error: "Không có quyền hủy đơn hàng" });
  }

  if (cancelBy === "customer" && order.userId.toString() !== req.user.id) {
    return res.status(403).json({ error: "Không có quyền hủy đơn hàng này" });
  }

  try {
    const statusContext = await OrderStatusContextFactory.create(
      orderId,
      req.redisClient
    );

    const newStatus = await statusContext.cancel(cancelBy, deliveryAddress);

    logger.info(`Đơn hàng ${orderId} đã bị hủy bởi ${cancelBy}`);
    const updatedOrder = await Order.findById(orderId);
    res.status(200).json({
      message: `Đã hủy đơn hàng`,
      data: updatedOrder,
    });
  } catch (error) {
    logger.error("Lỗi khi hủy đơn hàng:", error);
    res.status(400).json({ error: error.message });
  }
});

// Hàm mới: Yêu cầu trả hàng (sử dụng State Pattern)
const requestReturnOrder = asyncHandler(async (req, res, next) => {
  const orderId = req.params.id;
  const { deliveryAddress } = req.body;

  // Kiểm tra quyền: Customer chỉ có thể yêu cầu trả hàng đơn hàng của mình
  const order = await Order.findById(orderId);
  if (!order) {
    logger.warn("Đơn hàng không tồn tại");
    return res.status(404).json({ error: "Đơn hàng không tồn tại" });
  }

  if (order.userId.toString() !== req.user.id && !["Admin", "Employee"].includes(req.user.role)) {
    return res.status(403).json({ error: "Không có quyền yêu cầu trả hàng đơn hàng này" });
  }

  try {
    const statusContext = await OrderStatusContextFactory.create(
      orderId,
      req.redisClient
    );

    const newStatus = await statusContext.requestReturn(deliveryAddress);

    logger.info(`Đơn hàng ${orderId} đã được yêu cầu trả hàng`);
    const updatedOrder = await Order.findById(orderId);
    res.status(200).json({
      message: `Đã gửi yêu cầu trả hàng`,
      data: updatedOrder,
    });
  } catch (error) {
    logger.error("Lỗi khi yêu cầu trả hàng:", error);
    res.status(400).json({ error: error.message });
  }
});

// Hàm mới: Xác nhận trả hàng (sử dụng State Pattern)
const confirmReturnOrder = asyncHandler(async (req, res, next) => {
  const orderId = req.params.id;
  const { deliveryAddress } = req.body;

  try {
    const statusContext = await OrderStatusContextFactory.create(
      orderId,
      req.redisClient
    );

    const newStatus = await statusContext.confirmReturn(deliveryAddress);

    logger.info(`Đơn hàng ${orderId} đã được xác nhận trả hàng`);
    const updatedOrder = await Order.findById(orderId);
    res.status(200).json({
      message: `Đã xác nhận trả hàng`,
      data: updatedOrder,
    });
  } catch (error) {
    logger.error("Lỗi khi xác nhận trả hàng:", error);
    res.status(400).json({ error: error.message });
  }
});

// Hàm mới: Lấy lịch sử trạng thái đơn hàng
const getOrderStatusHistory = asyncHandler(async (req, res, next) => {
  const orderId = req.params.id;

  try {
    const statusContext = await OrderStatusContextFactory.create(orderId);
    const history = await statusContext.getStatusHistory();
    const currentStatus = statusContext.getCurrentStatus();

    res.status(200).json({
      currentStatus,
      history,
    });
  } catch (error) {
    logger.error("Lỗi khi lấy lịch sử trạng thái:", error);
    res.status(400).json({ error: error.message });
  }
});

export default {
  getAllOrders: getAllOrders,
  getOrderById: getOrderById,
  createOrder: createOrder,
  getAllOrdersByUserId: getAllOrdersByUserId,
  updateDeliveryInfoById: updateDeliveryInfoById,
  updatePaymentStatusById: updatePaymentStatusById,
  checkoutWithMoMo: checkoutWithMoMo,
  callbackMoMo: callbackMoMo,
  checkStatusTransaction: checkStatusTransaction,
  sendMailDeliveryInfo: sendMailDeliveryInfo,
  checkoutWithVnPay: checkoutWithVnPay,
  callbackVnPay: callbackVnPay,
  checkoutWithZaloPay: checkoutWithZaloPay,
  callbackZaloPay: callbackZaloPay,
  checkStatusTransactionZaloPay: checkStatusTransactionZaloPay,
  // Các hàm mới sử dụng State Pattern
  nextOrderStatus: nextOrderStatus,
  cancelOrder: cancelOrder,
  requestReturnOrder: requestReturnOrder,
  confirmReturnOrder: confirmReturnOrder,
  getOrderStatusHistory: getOrderStatusHistory,
};
