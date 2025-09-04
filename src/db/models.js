// src/db/models.js
import mongoose from "mongoose";

const SignRecordSchema = new mongoose.Schema(
  {
    sessionId: { type: String, index: true },
    user: { username: String, email: String },
    tempOriginalGridId: mongoose.Schema.Types.ObjectId,
    originalDriveId: String,
    signedDriveId: String,
    status: {
      type: String,
      enum: [
        "initialized",
        "opened",
        "document_uploaded",
        "signature_uploaded",
        "signed",
      ],
      default: "initialized",
    },
    createdAt: Date,
    signedAt: Date,
  },
  {
    versionKey: false,
    collection: "esign_records", // 👈 explicit collection name
  }
);

export const SignRecord = mongoose.model("SignRecord", SignRecordSchema);
