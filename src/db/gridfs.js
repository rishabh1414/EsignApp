import mongoose from "mongoose";

export const getGridFSBucket = () => {
  const db = mongoose.connection.db;
  if (!db) throw new Error("Mongo not connected yet");
  return new mongoose.mongo.GridFSBucket(db, { bucketName: "temp_uploads" });
};
