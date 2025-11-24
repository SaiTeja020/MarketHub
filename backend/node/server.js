const express = require("express");
const app = express();

app.get("/", (req, res) => {
  res.json({ message: "Node API running in Docker" });
});

app.listen(5000, () => {
  console.log("Node API running on port 5000");
});
