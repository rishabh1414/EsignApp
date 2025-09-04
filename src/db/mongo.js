// src/db/mongo.js
import mongoose from "mongoose";

export const connectMongo = async () => {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI missing");

  const opts = {};
  if (process.env.MONGO_DB_NAME) {
    opts.dbName = process.env.MONGO_DB_NAME;
  }

  await mongoose.connect(uri, opts);
  console.log("MongoDB connected to db:", mongoose.connection.name);
};
