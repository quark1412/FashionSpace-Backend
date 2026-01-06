# State Pattern - Order Status Management Guide

## 📋 Tổng quan

File `statusService.js` được thiết kế theo **State Design Pattern** để quản lý trạng thái đơn hàng một cách linh hoạt và dễ bảo trì.

## 🏗️ Kiến trúc State Pattern

### 1. **Context** - `OrderStatusContext`
- Quản lý trạng thái hiện tại của đơn hàng
- Cung cấp interface để chuyển đổi trạng thái
- Lưu trữ orderId và redisClient

### 2. **State Interface** - `OrderState`
- Định nghĩa các phương thức chung cho tất cả trạng thái
- `next()`: Chuyển sang trạng thái tiếp theo
- `cancel()`: Hủy đơn hàng
- `onEnter()`: Logic khi vào trạng thái
- `canTransitionTo()`: Kiểm tra có thể chuyển trạng thái
- `getStatusName()`: Lấy tên trạng thái

### 3. **Concrete States** - Các trạng thái cụ thể

| State Class | Trạng thái | Chuyển tiếp hợp lệ |
|------------|------------|-------------------|
| `PendingState` | Đang chờ | ACCEPTED, CANCELLED_CUSTOMER, CANCELLED_EMPLOYEE |
| `AcceptedState` | Đã nhận đơn | PROCESSING, CANCELLED_EMPLOYEE |
| `ProcessingState` | Đang xử lý | IN_DELIVERY, CANCELLED_EMPLOYEE |
| `InDeliveryState` | Đang giao | SHIPPED, RETURN |
| `ShippedState` | Đã giao | RETURN |
| `CancelledCustomerState` | Đã hủy (KH) | *Trạng thái cuối* |
| `CancelledEmployeeState` | Đã hủy (NV) | *Trạng thái cuối* |
| `ReturnState` | Yêu cầu trả | RETURNED |
| `ReturnedState` | Đã trả hàng | *Trạng thái cuối* |

## 🔄 Quy trình trạng thái

```
PENDING → ACCEPTED → PROCESSING → IN_DELIVERY → SHIPPED
    ↓         ↓           ↓              ↓          ↓
CANCELLED  CANCELLED  CANCELLED      RETURN    RETURN
                                        ↓
                                    RETURNED
```

## 📝 Cách sử dụng

### 1. Khởi tạo Context từ Database

```javascript
import { OrderStatusContextFactory } from "../services/statusService.js";

// Tạo context từ đơn hàng có sẵn
const statusContext = await OrderStatusContextFactory.create(
  orderId,
  redisClient  // Optional
);
```

### 2. Khởi tạo Context mới (cho đơn hàng mới)

```javascript
const statusContext = OrderStatusContextFactory.createNew(orderId, redisClient);
```

### 3. Chuyển sang trạng thái tiếp theo

```javascript
try {
  const newStatus = await statusContext.next("Địa chỉ giao hàng");
  console.log(`Trạng thái mới: ${newStatus}`);
} catch (error) {
  console.error(error.message); // Ví dụ: "Đơn hàng đã hoàn thành..."
}
```

### 4. Hủy đơn hàng

```javascript
try {
  // Hủy bởi khách hàng
  const newStatus = await statusContext.cancel("customer", "N/A");
  
  // Hủy bởi nhân viên
  const newStatus = await statusContext.cancel("employee", "Lý do hủy");
} catch (error) {
  console.error(error.message); // "Không thể hủy đơn hàng..."
}
```

### 5. Chuyển sang trạng thái cụ thể (với validation)

```javascript
try {
  const newStatus = await statusContext.transitionTo(
    orderStatus.IN_DELIVERY,
    "Đang giao đến địa chỉ..."
  );
} catch (error) {
  console.error(error.message); // "Không thể chuyển từ..."
}
```

### 6. Yêu cầu và xác nhận trả hàng

```javascript
// Yêu cầu trả hàng
const newStatus = await statusContext.requestReturn("Lý do trả");

// Xác nhận trả hàng (chỉ Employee)
const confirmedStatus = await statusContext.confirmReturn("Đã nhận hàng trả");
```

### 7. Lấy thông tin trạng thái

```javascript
// Trạng thái hiện tại
const currentStatus = statusContext.getCurrentStatus();

// Lịch sử trạng thái
const history = await statusContext.getStatusHistory();

// Kiểm tra có thể chuyển trạng thái
const canTransition = statusContext.canTransitionTo(orderStatus.SHIPPED);
```

## 🎯 Logic nghiệp vụ tự động

### Khi ACCEPTED (Đã nhận đơn):
- ✅ Tự động **trừ số lượng tồn kho** (stock)
- ✅ Cập nhật cache Redis

### Khi SHIPPED (Đã giao):
- ✅ Tự động **tăng số lượng đã bán** (soldQuantity)
- ✅ Cập nhật cache Redis
- ✅ **Thêm vào báo cáo doanh thu**

### Khi RETURNED (Đã trả hàng):
- ✅ Tự động **hoàn lại tồn kho**
- ✅ Cập nhật cache Redis

### Khi CANCELLED_EMPLOYEE (Hủy bởi NV):
- ✅ **Hoàn lại tồn kho** nếu đã trừ trước đó (status >= ACCEPTED)
- ✅ Cập nhật cache Redis

## 🔌 API Endpoints mới

### 1. Chuyển trạng thái tiếp theo
```
PUT /api/v1/order/next/:id
Authorization: Employee
Body: { "deliveryAddress": "..." }
```

### 2. Hủy đơn hàng
```
PUT /api/v1/order/cancel/:id
Authorization: Employee | Customer
Body: {
  "cancelBy": "customer" | "employee",
  "deliveryAddress": "Lý do hủy"
}
```

### 3. Yêu cầu trả hàng
```
PUT /api/v1/order/requestReturn/:id
Authorization: Employee | Customer
Body: { "deliveryAddress": "Lý do trả" }
```

### 4. Xác nhận trả hàng
```
PUT /api/v1/order/confirmReturn/:id
Authorization: Employee
Body: { "deliveryAddress": "Ghi chú" }
```

### 5. Lịch sử trạng thái
```
GET /api/v1/order/statusHistory/:id
Authorization: Any authenticated user
```

### 6. Cập nhật trạng thái (API cũ - đã được cải tiến)
```
PUT /api/v1/order/deliveryInfo/:id
Authorization: Employee | Customer
Body: {
  "status": "Đang giao",
  "deliveryAddress": "...",
  "expectedDeliveryDate": "2026-01-15"
}
```

## ⚡ So sánh với code cũ

### ❌ Code cũ (Không dùng Pattern)
```javascript
// Logic phân tán, khó maintain
if (status === orderStatus.ACCEPTED) {
  // Trừ stock...
}
if (status === orderStatus.RETURNED) {
  // Hoàn stock...
}
if (status === orderStatus.SHIPPED) {
  // Tăng soldQuantity...
  addOrderToReport(order.finalPrice);
}
// Không có validation chuyển trạng thái
order.deliveryInfo.push({ status, deliveryAddress });
```

### ✅ Code mới (State Pattern)
```javascript
// Logic tập trung trong từng State class
// Tự động validation chuyển trạng thái
const statusContext = await OrderStatusContextFactory.create(orderId);

// Chuyển trạng thái an toàn
if (!statusContext.canTransitionTo(newStatus)) {
  throw new Error("Không thể chuyển trạng thái");
}

await statusContext.transitionTo(newStatus, deliveryAddress);
```

## 🎓 Ưu điểm của State Pattern

1. **Single Responsibility**: Mỗi state class chỉ xử lý logic của trạng thái đó
2. **Open/Closed Principle**: Dễ thêm trạng thái mới mà không sửa code cũ
3. **Validation tự động**: Ngăn chặn chuyển trạng thái không hợp lệ
4. **Code rõ ràng**: Logic dễ đọc, dễ hiểu, dễ maintain
5. **Tái sử dụng**: Có thể dùng lại logic ở nhiều nơi
6. **Testing**: Dễ dàng test từng trạng thái độc lập

## 🛠️ Mở rộng

### Thêm trạng thái mới

1. Tạo class kế thừa `OrderState`
2. Implement các phương thức bắt buộc
3. Thêm vào `stateMap` trong `OrderStatusContext.getStateInstance()`
4. Cập nhật `orderStatus` config
5. Cập nhật model validation

Ví dụ:
```javascript
export class PartiallyShippedState extends OrderState {
  getStatusName() {
    return "Đã giao một phần";
  }
  
  canTransitionTo(newStatus) {
    return [orderStatus.SHIPPED, orderStatus.RETURN].includes(newStatus);
  }
  
  async next() {
    await this.context.setState(new ShippedState(this.context));
    return orderStatus.SHIPPED;
  }
  
  async onEnter() {
    // Logic khi giao một phần
  }
}
```

## 📚 Tham khảo

- Strategy Pattern: [src/services/paymentService.js](paymentService.js)
- State Pattern Theory: https://refactoring.guru/design-patterns/state
- Controller sử dụng: [src/controllers/orderController.js](../controllers/orderController.js)
