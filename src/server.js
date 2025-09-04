import "dotenv/config";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { connectMongo } from "./db/mongo.js";
import esignRoutes from "./routes/esign.routes.js";
import { errorHandler, notFound } from "./middlewares/errorHandler.js";

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

await connectMongo();

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(
  helmet({ crossOriginEmbedderPolicy: false, contentSecurityPolicy: false })
);
app.use(limiter);
app.use(cors({ origin: true, credentials: false }));
app.use(morgan("dev"));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// Static UI
app.use("/", express.static(path.join(__dirname, "public")));

// API
app.use("/api/esign", esignRoutes);

// Health
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// Errors
app.use(notFound);
app.use(errorHandler);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`eSign on http://localhost:${port}`));
