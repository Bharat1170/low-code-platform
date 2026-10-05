import mongoose from "mongoose";
import { env } from "./env.js";

export const connectDatabase = async (): Promise<void> => {
  try {
    await mongoose.connect(env.MONGO_URI, {
      serverSelectionTimeoutMS: 5000,
    });

    console.log("✅ MongoDB connected successfully");

    console.log(
      "MongoDB retryWrites:",
      mongoose.connection.getClient().options.retryWrites,
    );
  } catch (error) {
    console.error("❌ MongoDB connection failed");
    throw error;
  }
};

export const disconnectDatabase = async (): Promise<void> => {
  await mongoose.disconnect();
  console.log("MongoDB disconnected");
};