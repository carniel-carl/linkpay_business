// Bun loads .env automatically.
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const env = {
  port: Number(process.env.PORT ?? 4000),
  mongoUri: process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017/linkpay",
  nodeEnv: process.env.NODE_ENV ?? "development",
  appName: process.env.APP_NAME ?? "LinkPay",
  jwtSecret: required("JWT_SECRET"),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "7d",
};
