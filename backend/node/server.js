const { Pool } = require("pg");
const express = require("express");
const app = express();

app.get("/health", (req, res) => res.send("OK"));

app.listen(5000, "0.0.0.0", () => {
  console.log(`Server running on port 5000`);
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

app.get("/db-test/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      "SELECT id, title, current_price FROM products WHERE id = $1",
      [id]
    );

    if (result.rows.length === 0) {
      return res.json({ status: "not_found" });
    }

    res.json({ status: "ok", product: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.json({ status: "error", message: err.message });
  }
});
