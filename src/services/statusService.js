import Order from "../models/order.js";
import Product from "../models/product.js";
import ProductVariant from "../models/productVariant.js";
import { orderStatus } from "../config/orderStatus.js";
import logger from "../utils/logger.js";
import { addOrderToReport } from "../controllers/statisticController.js";

/**
 * State Pattern Implementation for Order Status Management
 * 
 * Context: OrderStatusContext - Quản lý trạng thái đơn hàng
 * State Interface: OrderState - Interface cho các trạng thái
 * Concrete States: PendingState, AcceptedState, ProcessingState, v.v.
 */

// State Interface - Định nghĩa các hành động chung cho mọi trạng thái
export class OrderState {
  constructor(context) {
    this.context = context;
  }

  // Chuyển sang trạng thái tiếp theo
  async next() {
    throw new Error("Method 'next()' must be implemented by concrete state");
  }

  // Hủy đơn hàng
  async cancel(cancelBy) {
    throw new Error("Method 'cancel()' must be implemented by concrete state");
  }

  // Xử lý khi vào trạng thái này
  async onEnter() {
    throw new Error("Method 'onEnter()' must be implemented by concrete state");
  }

  // Kiểm tra có thể chuyển sang trạng thái mới không
  canTransitionTo(newStatus) {
    throw new Error("Method 'canTransitionTo()' must be implemented by concrete state");
  }

  // Lấy tên trạng thái
  getStatusName() {
    throw new Error("Method 'getStatusName()' must be implemented by concrete state");
  }
}

// Concrete State: Đang chờ
export class PendingState extends OrderState {
  getStatusName() {
    return orderStatus.PENDING;
  }

  canTransitionTo(newStatus) {
    const allowedTransitions = [
      orderStatus.ACCEPTED,
      orderStatus.CANCELLED_CUSTOMER,
      orderStatus.CANCELLED_EMPLOYEE,
    ];
    return allowedTransitions.includes(newStatus);
  }

  async next() {
    await this.context.setState(new AcceptedState(this.context));
    return orderStatus.ACCEPTED;
  }

  async cancel(cancelBy = "customer") {
    if (cancelBy === "customer") {
      await this.context.setState(new CancelledCustomerState(this.context));
      return orderStatus.CANCELLED_CUSTOMER;
    } else {
      await this.context.setState(new CancelledEmployeeState(this.context));
      return orderStatus.CANCELLED_EMPLOYEE;
    }
  }

  async onEnter() {
    logger.info(`Đơn hàng ${this.context.orderId} đang ở trạng thái: ${this.getStatusName()}`);
    // Không cần xử lý gì đặc biệt cho trạng thái pending
  }
}

// Concrete State: Đã nhận đơn
export class AcceptedState extends OrderState {
  getStatusName() {
    return orderStatus.ACCEPTED;
  }

  canTransitionTo(newStatus) {
    const allowedTransitions = [
      orderStatus.PROCESSING,
      orderStatus.CANCELLED_EMPLOYEE,
    ];
    return allowedTransitions.includes(newStatus);
  }

  async next() {
    await this.context.setState(new ProcessingState(this.context));
    return orderStatus.PROCESSING;
  }

  async cancel(cancelBy = "employee") {
    // Chỉ employee mới có thể hủy sau khi đã nhận đơn
    if (cancelBy === "employee") {
      await this.context.setState(new CancelledEmployeeState(this.context));
      return orderStatus.CANCELLED_EMPLOYEE;
    } else {
      throw new Error("Không thể hủy đơn hàng sau khi đã được nhận");
    }
  }

  async onEnter() {
    logger.info(`Đơn hàng ${this.context.orderId} đã được nhận`);
    
    // Trừ số lượng tồn kho khi nhận đơn
    const order = await Order.findById(this.context.orderId);
    if (order) {
      for (let orderItem of order.orderItems) {
        const productVariant = await ProductVariant.findById(orderItem.productVariantId);
        if (productVariant) {
          productVariant.stock -= orderItem.quantity;
          await productVariant.save();
          
          // Cập nhật cache nếu có
          if (this.context.redisClient) {
            const cacheKey = `productVariant:${orderItem.productVariantId}`;
            await this.context.redisClient.hincrby(cacheKey, "stock", -orderItem.quantity);
          }
        }
      }
    }
  }
}

// Concrete State: Đang xử lý
export class ProcessingState extends OrderState {
  getStatusName() {
    return orderStatus.PROCESSING;
  }

  canTransitionTo(newStatus) {
    const allowedTransitions = [
      orderStatus.IN_DELIVERY,
      orderStatus.CANCELLED_EMPLOYEE,
    ];
    return allowedTransitions.includes(newStatus);
  }

  async next() {
    await this.context.setState(new InDeliveryState(this.context));
    return orderStatus.IN_DELIVERY;
  }

  async cancel(cancelBy = "employee") {
    // Chỉ employee mới có thể hủy khi đang xử lý
    if (cancelBy === "employee") {
      await this.context.setState(new CancelledEmployeeState(this.context));
      return orderStatus.CANCELLED_EMPLOYEE;
    } else {
      throw new Error("Không thể hủy đơn hàng khi đang xử lý");
    }
  }

  async onEnter() {
    logger.info(`Đơn hàng ${this.context.orderId} đang được xử lý`);
  }
}

// Concrete State: Đang giao
export class InDeliveryState extends OrderState {
  getStatusName() {
    return orderStatus.IN_DELIVERY;
  }

  canTransitionTo(newStatus) {
    const allowedTransitions = [
      orderStatus.SHIPPED,
      orderStatus.RETURN,
    ];
    return allowedTransitions.includes(newStatus);
  }

  async next() {
    await this.context.setState(new ShippedState(this.context));
    return orderStatus.SHIPPED;
  }

  async cancel() {
    throw new Error("Không thể hủy đơn hàng khi đang giao");
  }

  async onEnter() {
    logger.info(`Đơn hàng ${this.context.orderId} đang được giao`);
  }

  async requestReturn() {
    await this.context.setState(new ReturnState(this.context));
    return orderStatus.RETURN;
  }
}

// Concrete State: Đã giao
export class ShippedState extends OrderState {
  getStatusName() {
    return orderStatus.SHIPPED;
  }

  canTransitionTo(newStatus) {
    const allowedTransitions = [orderStatus.RETURN];
    return allowedTransitions.includes(newStatus);
  }

  async next() {
    throw new Error("Đơn hàng đã hoàn thành, không thể chuyển sang trạng thái tiếp theo");
  }

  async cancel() {
    throw new Error("Không thể hủy đơn hàng đã giao thành công");
  }

  async onEnter() {
    logger.info(`Đơn hàng ${this.context.orderId} đã giao thành công`);
    
    // Cập nhật số lượng đã bán và doanh thu
    const order = await Order.findById(this.context.orderId);
    if (order) {
      for (let orderItem of order.orderItems) {
        const product = await Product.findById(orderItem.productId);
        if (product) {
          product.soldQuantity += orderItem.quantity;
          await product.save();
          
          // Cập nhật cache nếu có
          if (this.context.redisClient) {
            const cacheKey = `product:${orderItem.productId}`;
            await this.context.redisClient.hincrby(
              cacheKey,
              "soldQuantity",
              orderItem.quantity
            );
          }
        }
      }
      
      // Thêm vào báo cáo doanh thu
      addOrderToReport(order.finalPrice);
    }
  }

  async requestReturn() {
    await this.context.setState(new ReturnState(this.context));
    return orderStatus.RETURN;
  }
}

// Concrete State: Đã hủy bởi khách hàng
export class CancelledCustomerState extends OrderState {
  getStatusName() {
    return orderStatus.CANCELLED_CUSTOMER;
  }

  canTransitionTo() {
    return false; // Trạng thái cuối, không thể chuyển
  }

  async next() {
    throw new Error("Đơn hàng đã bị hủy, không thể chuyển sang trạng thái khác");
  }

  async cancel() {
    throw new Error("Đơn hàng đã bị hủy");
  }

  async onEnter() {
    logger.info(`Đơn hàng ${this.context.orderId} đã bị hủy bởi khách hàng`);
  }
}

// Concrete State: Đã hủy bởi nhân viên
export class CancelledEmployeeState extends OrderState {
  getStatusName() {
    return orderStatus.CANCELLED_EMPLOYEE;
  }

  canTransitionTo() {
    return false; // Trạng thái cuối, không thể chuyển
  }

  async next() {
    throw new Error("Đơn hàng đã bị hủy, không thể chuyển sang trạng thái khác");
  }

  async cancel() {
    throw new Error("Đơn hàng đã bị hủy");
  }

  async onEnter() {
    logger.info(`Đơn hàng ${this.context.orderId} đã bị hủy bởi nhân viên`);
    
    // Hoàn lại số lượng tồn kho nếu đã trừ trước đó
    const order = await Order.findById(this.context.orderId);
    if (order && order.deliveryInfo && order.deliveryInfo.length > 0) {
      // Kiểm tra xem có trạng thái ACCEPTED trước đó không
      const hasAccepted = order.deliveryInfo.some(
        info => info.status === orderStatus.ACCEPTED
      );
      
      if (hasAccepted) {
        for (let orderItem of order.orderItems) {
          const productVariant = await ProductVariant.findById(orderItem.productVariantId);
          if (productVariant) {
            productVariant.stock += orderItem.quantity;
            await productVariant.save();
            
            // Cập nhật cache nếu có
            if (this.context.redisClient) {
              const cacheKey = `productVariant:${orderItem.productVariantId}`;
              await this.context.redisClient.hincrby(cacheKey, "stock", orderItem.quantity);
            }
          }
        }
      }
    }
  }
}

// Concrete State: Trả hàng (đang yêu cầu)
export class ReturnState extends OrderState {
  getStatusName() {
    return orderStatus.RETURN;
  }

  canTransitionTo(newStatus) {
    const allowedTransitions = [orderStatus.RETURNED];
    return allowedTransitions.includes(newStatus);
  }

  async next() {
    await this.context.setState(new ReturnedState(this.context));
    return orderStatus.RETURNED;
  }

  async cancel() {
    throw new Error("Không thể hủy yêu cầu trả hàng");
  }

  async onEnter() {
    logger.info(`Đơn hàng ${this.context.orderId} đang được yêu cầu trả hàng`);
  }
}

// Concrete State: Đã trả hàng
export class ReturnedState extends OrderState {
  getStatusName() {
    return orderStatus.RETURNED;
  }

  canTransitionTo() {
    return false; // Trạng thái cuối, không thể chuyển
  }

  async next() {
    throw new Error("Đơn hàng đã được trả, không thể chuyển sang trạng thái khác");
  }

  async cancel() {
    throw new Error("Không thể hủy đơn hàng đã trả");
  }

  async onEnter() {
    logger.info(`Đơn hàng ${this.context.orderId} đã được trả thành công`);
    
    // Hoàn lại số lượng tồn kho
    const order = await Order.findById(this.context.orderId);
    if (order) {
      for (let orderItem of order.orderItems) {
        const productVariant = await ProductVariant.findById(orderItem.productVariantId);
        if (productVariant) {
          productVariant.stock += orderItem.quantity;
          await productVariant.save();
          
          // Cập nhật cache nếu có
          if (this.context.redisClient) {
            const cacheKey = `productVariant:${orderItem.productVariantId}`;
            await this.context.redisClient.hincrby(cacheKey, "stock", orderItem.quantity);
          }
        }
      }
    }
  }
}

// Context - Quản lý trạng thái đơn hàng
export class OrderStatusContext {
  constructor(orderId, redisClient = null) {
    this.orderId = orderId;
    this.redisClient = redisClient;
    this.currentState = null;
  }

  // Thiết lập trạng thái mới
  async setState(newState) {
    this.currentState = newState;
    await this.currentState.onEnter();
  }

  // Khởi tạo trạng thái từ DB
  async initializeFromDatabase() {
    const order = await Order.findById(this.orderId);
    if (!order) {
      throw new Error("Đơn hàng không tồn tại");
    }

    // Lấy trạng thái mới nhất
    const currentStatus = order.deliveryInfo && order.deliveryInfo.length > 0
      ? order.deliveryInfo[order.deliveryInfo.length - 1].status
      : orderStatus.PENDING;

    const state = this.getStateInstance(currentStatus);
    this.currentState = state;
    
    return currentStatus;
  }

  // Lấy instance của state dựa trên tên trạng thái
  getStateInstance(statusName) {
    const stateMap = {
      [orderStatus.PENDING]: PendingState,
      [orderStatus.ACCEPTED]: AcceptedState,
      [orderStatus.PROCESSING]: ProcessingState,
      [orderStatus.IN_DELIVERY]: InDeliveryState,
      [orderStatus.SHIPPED]: ShippedState,
      [orderStatus.CANCELLED_CUSTOMER]: CancelledCustomerState,
      [orderStatus.CANCELLED_EMPLOYEE]: CancelledEmployeeState,
      [orderStatus.RETURN]: ReturnState,
      [orderStatus.RETURNED]: ReturnedState,
    };

    const StateClass = stateMap[statusName];
    if (!StateClass) {
      throw new Error(`Trạng thái không hợp lệ: ${statusName}`);
    }

    return new StateClass(this);
  }

  // Chuyển sang trạng thái tiếp theo
  async next(deliveryAddress = null) {
    if (!this.currentState) {
      throw new Error("Chưa khởi tạo trạng thái");
    }

    const newStatus = await this.currentState.next();
    await this.updateOrderDeliveryInfo(newStatus, deliveryAddress);
    return newStatus;
  }

  // Hủy đơn hàng
  async cancel(cancelBy = "customer", deliveryAddress = null) {
    if (!this.currentState) {
      throw new Error("Chưa khởi tạo trạng thái");
    }

    const newStatus = await this.currentState.cancel(cancelBy);
    await this.updateOrderDeliveryInfo(newStatus, deliveryAddress);
    return newStatus;
  }

  // Chuyển sang trạng thái cụ thể (với validation)
  async transitionTo(newStatus, deliveryAddress = null) {
    if (!this.currentState) {
      throw new Error("Chưa khởi tạo trạng thái");
    }

    if (!this.currentState.canTransitionTo(newStatus)) {
      throw new Error(
        `Không thể chuyển từ trạng thái "${this.currentState.getStatusName()}" sang "${newStatus}"`
      );
    }

    const newState = this.getStateInstance(newStatus);
    await this.setState(newState);
    await this.updateOrderDeliveryInfo(newStatus, deliveryAddress);
    return newStatus;
  }

  // Yêu cầu trả hàng
  async requestReturn(deliveryAddress = null) {
    if (!this.currentState) {
      throw new Error("Chưa khởi tạo trạng thái");
    }

    // Chỉ cho phép trả hàng từ trạng thái IN_DELIVERY hoặc SHIPPED
    if (this.currentState instanceof InDeliveryState || 
        this.currentState instanceof ShippedState) {
      const newStatus = await this.currentState.requestReturn();
      await this.updateOrderDeliveryInfo(newStatus, deliveryAddress);
      return newStatus;
    } else {
      throw new Error("Chỉ có thể yêu cầu trả hàng khi đơn hàng đang giao hoặc đã giao");
    }
  }

  // Xác nhận trả hàng
  async confirmReturn(deliveryAddress = null) {
    if (!this.currentState) {
      throw new Error("Chưa khởi tạo trạng thái");
    }

    if (this.currentState instanceof ReturnState) {
      const newStatus = await this.currentState.next();
      await this.updateOrderDeliveryInfo(newStatus, deliveryAddress);
      return newStatus;
    } else {
      throw new Error("Đơn hàng chưa ở trạng thái yêu cầu trả hàng");
    }
  }

  // Cập nhật deliveryInfo trong database
  async updateOrderDeliveryInfo(status, deliveryAddress = null) {
    const order = await Order.findById(this.orderId);
    if (!order) {
      throw new Error("Đơn hàng không tồn tại");
    }

    order.deliveryInfo.push({
      status,
      deliveryAddress: deliveryAddress || "N/A",
      deliveryDate: new Date(),
    });

    await order.save();
    logger.info(`Đã cập nhật trạng thái đơn hàng ${this.orderId} thành ${status}`);
  }

  // Lấy trạng thái hiện tại
  getCurrentStatus() {
    if (!this.currentState) {
      throw new Error("Chưa khởi tạo trạng thái");
    }
    return this.currentState.getStatusName();
  }

  // Lấy lịch sử trạng thái
  async getStatusHistory() {
    const order = await Order.findById(this.orderId);
    if (!order) {
      throw new Error("Đơn hàng không tồn tại");
    }
    return order.deliveryInfo;
  }

  // Kiểm tra có thể chuyển sang trạng thái mới không
  canTransitionTo(newStatus) {
    if (!this.currentState) {
      return false;
    }
    return this.currentState.canTransitionTo(newStatus);
  }
}

// Factory Pattern để tạo context dễ dàng hơn
export class OrderStatusContextFactory {
  static async create(orderId, redisClient = null) {
    const context = new OrderStatusContext(orderId, redisClient);
    await context.initializeFromDatabase();
    return context;
  }

  static createNew(orderId, redisClient = null) {
    const context = new OrderStatusContext(orderId, redisClient);
    context.setState(new PendingState(context));
    return context;
  }
}

export default {
  OrderStatusContext,
  OrderStatusContextFactory,
  OrderState,
  PendingState,
  AcceptedState,
  ProcessingState,
  InDeliveryState,
  ShippedState,
  CancelledCustomerState,
  CancelledEmployeeState,
  ReturnState,
  ReturnedState,
};
