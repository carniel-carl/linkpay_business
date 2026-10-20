import { useLocalSearchParams } from "expo-router";
import { PaymentDetail } from "@/components/payments/payment-detail";

export default function PaymentScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <PaymentDetail id={id} />;
}
