import deliveryInfoComponent from "../config/deliveryInfoComponent.js";
import { Resend } from "resend";

const sendDeliveryInfo = async (email, order) => {
  try {
    const htmlDeliveryInfo = await deliveryInfoComponent(order);

    const resend = new Resend(process.env.RESEND_API_KEY);

    await resend.emails.send({
      from: "Fashion Space <onboarding@resend.dev>",
      to: `${email}`,
      subject: `THÔNG TIN ĐƠN HÀNG ${order._id} CỦA BẠN ĐÃ ĐƯỢC CẬP NHẬT - FASHION SPACE`,
      html: htmlDeliveryInfo,
    });
  } catch (err) {
    throw new Error(err.message);
  }
};

export default sendDeliveryInfo;
