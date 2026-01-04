import axios from "axios";
import Order from "../models/order.js";
import { messages } from "../config/messageHelper.js";
import crypto from "crypto";
import moment from "moment";
import logger from "../utils/logger.js";
import { paymentStatus } from "../config/paymentStatus.js";

// Strategy Interface
export class PaymentStrategy {
  async checkout(orderId, amount) {
    throw new Error("Method must be implemented by concrete strategy");
  }

  async callback() {
    throw new Error("Method must be implemented by concrete strategy");
  }
}

// Concrete Strategies
export class MoMoPaymentStrategy extends PaymentStrategy {
  async checkout(orderId, amount) {
    try {
      const accessKey = "F8BBA842ECF85";
      const secretKey = "K951B6PE1waDMi640xX08PD3vg6EkVlz";
      const orderInfo = "Checkout with MoMo";
      const partnerCode = "MOMO";
      const redirectUrl = `${process.env.URL_CLIENT}/orderCompleted`;
      const ipnUrl = `${process.env.LINK_NGROK}/api/v1/order/callbackMoMo`;
      const requestType = "payWithMethod";
      const requestId = orderId;
      const extraData = "";
      const orderGroupId = "";
      const autoCapture = true;
      const lang = "vi";

      let rawSignature =
        "accessKey=" +
        accessKey +
        "&amount=" +
        amount +
        "&extraData=" +
        extraData +
        "&ipnUrl=" +
        ipnUrl +
        "&orderId=" +
        orderId +
        "&orderInfo=" +
        orderInfo +
        "&partnerCode=" +
        partnerCode +
        "&redirectUrl=" +
        redirectUrl +
        "&requestId=" +
        requestId +
        "&requestType=" +
        requestType;

      let signature = crypto
        .createHmac("sha256", secretKey)
        .update(rawSignature)
        .digest("hex");

      const requestBody = JSON.stringify({
        partnerCode: partnerCode,
        partnerName: "Test",
        storeId: "MomoTestStore",
        requestId: requestId,
        amount: amount,
        orderId: orderId,
        orderInfo: orderInfo,
        redirectUrl: redirectUrl,
        ipnUrl: ipnUrl,
        lang: lang,
        requestType: requestType,
        autoCapture: autoCapture,
        extraData: extraData,
        orderGroupId: orderGroupId,
        signature: signature,
      });

      const options = {
        method: "POST",
        url: "https://test-payment.momo.vn/v2/gateway/api/create",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(requestBody),
        },
        data: requestBody,
      };

      const response = await axios(options);
      logger.info("Bắt đầu quá trình thanh toán Momo");
      return response.data;
    } catch (error) {
      logger.error(messages.MSG5, error);
      throw new Error({
        error: error.message,
        message: messages.MSG5,
      });
    }
  }

  setOrderId(orderId) {
    this.orderId = orderId;
  }

  setResultCode(resultCode) {
    this.resultCode = resultCode;
  }

  async callback() {
    try {
      if (this.resultCode === 0) {
        const order = await Order.findById({ _id: this.orderId });

        if (!order) {
          logger.warn("Đơn hàng không tồn tại");
          throw new Error("Not found");
        }

        order.paymentStatus = paymentStatus.PAID;
        order.save();
      }
    } catch (error) {
      logger.error(messages.MSG5, error);
      throw new Error({
        error: error.message,
        message: messages.MSG5,
      });
    }
  }
}

export class VnPayPaymentStrategy extends PaymentStrategy {
  setQuery(query) {
    this.query = query;
  }

  setIpAddr(ipAddr) {
    this.ipAddr = ipAddr;
  }

  setBankCode(bankCode) {
    this.bankCode = bankCode;
  }

  async checkout(orderId, amount) {
    try {
      const orderInfo = "Thanh toán đơn hàng";
      const createDate = moment(new Date()).format("YYYYMMDDHHmmss");
      const bankCode = this.bankCode || "NCB";
      const ipAddr = this.ipAddr;

      const vnpUrl = process.env.VNP_URL;
      const vnpReturnUrl = `${process.env.URL_SERVER}/api/v1/order/callbackVnPay`;
      const vnpTmnCode = process.env.VNP_TMNCODE;
      const vnpHashSecret = process.env.VNP_HASH_SECRET;

      let vnpParams = {
        vnp_Version: "2.1.0",
        vnp_Command: "pay",
        vnp_TmnCode: vnpTmnCode,
        vnp_Amount: amount * 100,
        vnp_CurrCode: "VND",
        vnp_BankCode: bankCode,
        vnp_Locale: "vn",
        vnp_CreateDate: createDate,
        vnp_OrderInfo: orderInfo,
        vnp_OrderType: "other",
        vnp_ReturnUrl: vnpReturnUrl,
        vnp_IpAddr: ipAddr,
        vnp_TxnRef: orderId,
      };

      vnpParams = Object.keys(vnpParams)
        .sort()
        .reduce((acc, key) => {
          acc[key] = vnpParams[key];
          return acc;
        }, {});

      let queryString = new URLSearchParams(vnpParams).toString();
      let hmac = crypto.createHmac("sha512", vnpHashSecret);
      let signed = hmac.update(Buffer.from(queryString, "utf-8")).digest("hex");
      vnpParams["vnp_SecureHash"] = signed;
      queryString = new URLSearchParams(vnpParams).toString();

      logger.info("Gửi url thanh toán VnPay thành công!");
      const url = `${vnpUrl}?${queryString}`;
      return url;
    } catch (error) {
      logger.error(messages.MSG5, error);
      throw new Error({
        error: error.message,
        message: messages.MSG5,
      });
    }
  }

  async callback() {
    try {
      let vnpParams = this.query;
      const secureHash = vnpParams["vnp_SecureHash"];

      const orderId = vnpParams["vnp_TxnRef"];
      const responseCode = vnpParams["vnp_ResponseCode"];
      const vnpHashSecret = process.env.VNP_HASH_SECRET;

      delete vnpParams["vnp_SecureHash"];

      vnpParams = Object.keys(vnpParams)
        .sort()
        .reduce((acc, key) => {
          acc[key] = vnpParams[key];
          return acc;
        }, {});

      const queryString = new URLSearchParams(vnpParams).toString();
      const hmac = crypto.createHmac("sha512", vnpHashSecret);
      const signed = hmac
        .update(Buffer.from(queryString, "utf-8"))
        .digest("hex");

      if (secureHash === signed) {
        const order = await Order.findById(orderId);

        if (!order) {
          logger.warn("Đơn hàng không tồn tại");
          throw new Error("Not found");
        }

        if (order.paymentStatus === paymentStatus.PAID) {
          logger.warn("Đơn hàng đã được thanh toán trước đó");
          throw new Error("Đơn hàng đã được thanh toán");
        }

        if (order.finalPrice !== vnpParams["vnp_Amount"] / 100) {
          logger.warn("Số tiền thanh toán không khớp với đơn hàng");
          throw new Error("Số tiền thanh toán không khớp");
        }

        if (responseCode === "00") {
          order.paymentStatus = paymentStatus.PAID;
          await order.save();

          logger.info("Thanh toán VnPay thành công!");
          const url = `${process.env.URL_CLIENT}/orderCompleted?orderId=${orderId}`;
          return url;
        }
      }

      logger.warn("Thanh toán VnPay thất bại!");
      throw new Error("Thanh toán VnPay thất bại!");
    } catch (error) {
      logger.error("Có lỗi xảy ra trong quá trình thanh toán VnPay", error);
      throw new Error({
        error: error.message,
        message: "Có lỗi xảy ra trong quá trình thanh toán VnPay",
      });
    }
  }
}

export class ZaloPayPaymentStrategy extends PaymentStrategy {
  async checkout(orderId, amount) {
    try {
      const app_id = "2553";
      const key1 = "PcY4iZIKFCIdgZvA6ueMcMHHUbRLYjPL";
      const endpoint = "https://sb-openapi.zalopay.vn/v2/create";

      const embed_data = {
        redirectUrl: `${process.env.URL_CLIENT}/orderCompleted`,
      };
      const order = await Order.findById(orderId);
      if (!order) {
        throw new Error("Not found");
      }

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

      const result = await axios.post(endpoint, null, {
        params: zaloPayParams,
      });
      return result.data;
    } catch (error) {
      logger.error(messages.MSG5, error);
      throw new Error({
        error: error.message,
        message: messages.MSG5,
      });
    }
  }

  setData(data) {
    this.data = data;
  }

  setMac(mac) {
    this.mac = mac;
  }

  async callback() {
    try {
      const key2 = "kLtgPl8HHhfvMuDHPwKfgfsY4Ydm9eIz";
      const { app_trans_id, amount } = JSON.parse(this.data);

      const raw = this.data;
      const orderId = app_trans_id.split("_")[1];
      const order = await Order.findById(orderId);
      if (!order) {
        logger.warn("Đơn hàng không tồn tại");
        throw new Error("Not found");
      }

      const expected = crypto
        .createHmac("sha256", key2)
        .update(raw)
        .digest("hex");

      if (expected !== this.mac) {
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
    } catch (error) {
      logger.error("Có lỗi xảy ra trong quá trình thanh toán ZaloPay", error);
      throw new Error({
        error: error.message,
        message: "Có lỗi xảy ra trong quá trình thanh toán ZaloPay",
      });
    }
  }
}

// Context
export class PaymentContext {
  constructor(strategy = null) {
    this.strategy = strategy;
  }

  setStrategy(strategy) {
    this.strategy = strategy;
  }

  async checkout(orderId, amount) {
    if (!this.strategy) {
      throw new Error("Payment strategy not set");
    }
    return await this.strategy.checkout(orderId, amount);
  }

  async callback() {
    if (!this.strategy) {
      throw new Error("Payment strategy not set");
    }
    return await this.strategy.callback();
  }
}
