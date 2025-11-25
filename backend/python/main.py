from fastapi import FastAPI
import os
import psycopg2
from psycopg2.extras import RealDictCursor

app = FastAPI()

# --- Database Connection ---
DATABASE_URL = os.getenv("DATABASE_URL")

def get_db_connection():
    conn = psycopg2.connect(DATABASE_URL, cursor_factory=RealDictCursor)
    return conn

@app.get("/db-test/{product_id}")
def db_test(product_id: str):
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("SELECT id, title, current_price FROM products WHERE id=%s", (product_id,))
        row = cur.fetchone()
        cur.close()
        conn.close()

        if not row:
            return {"status": "not_found"}
        return {"status": "ok", "product": row}

    except Exception as e:
        return {"status": "error", "message": str(e)}
