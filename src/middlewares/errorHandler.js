export const notFound = (_req, res) => {
  res.status(404).json({ error: "NotFound", message: "Route not found" });
};

export const errorHandler = (err, _req, res, _next) => {
  console.error(err);
  const status = err.status || 500;
  const message = err.message || "Internal Server Error";
  const details =
    process.env.NODE_ENV === "development" ? err.stack : undefined;
  res
    .status(status)
    .json({ error: "ServerError", message, ...(details ? { details } : {}) });
};
