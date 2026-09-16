import express from 'express';
import cors from 'cors';
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = 5000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname, { index: false }));

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'swiftshop',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4'
});

async function initializeDatabase() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schemaSql = await fs.readFile(schemaPath, 'utf8');
  const bootstrapConnection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    multipleStatements: false,
    charset: 'utf8mb4'
  });

  try {
    const statements = schemaSql
      .split(/;\s*(?:\r?\n|$)/)
      .map((statement) => statement.trim())
      .filter(Boolean);

    for (const statement of statements) {
      try {
        await bootstrapConnection.query(statement);
      } catch (error) {
        if (error.code !== 'ER_DUP_KEYNAME') {
          throw error;
        }
      }
    }

    console.log('SwiftShop database initialized and seeded.');
  } finally {
    await bootstrapConnection.end();
  }
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'));
});

app.get('/store', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/api/products', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM products ORDER BY id DESC');
    res.json(rows);
  } catch (error) {
    console.error('Error fetching products:', error);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

app.post('/api/products', async (req, res) => {
  try {
    const { title, price, category, image, description } = req.body;
    const numericPrice = Number(price);

    if (!String(title || '').trim() || !Number.isFinite(numericPrice) || numericPrice < 0) {
      return res.status(400).json({ error: 'Title and price are required' });
    }

    const [result] = await pool.query(
      'INSERT INTO products (title, price, category, image, description) VALUES (?, ?, ?, ?, ?)',
      [String(title).trim(), numericPrice, category || null, image || null, description || null]
    );

    const [rows] = await pool.query('SELECT * FROM products WHERE id = ?', [result.insertId]);
    res.status(201).json(rows[0]);
  } catch (error) {
    console.error('Error creating product:', error);
    res.status(500).json({ error: 'Failed to create product' });
  }
});

app.delete('/api/products/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [result] = await pool.query('DELETE FROM products WHERE id = ?', [id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    res.json({ message: 'Product deleted successfully' });
  } catch (error) {
    console.error('Error deleting product:', error);
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

app.get('/api/orders', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT
        o.id,
        o.user_id,
        o.total_amount,
        o.status,
        o.created_at,
        u.name AS name,
        u.email AS email
      FROM orders o
      JOIN users u ON o.user_id = u.id
      ORDER BY o.id DESC
    `);
    res.json(rows);
  } catch (error) {
    console.error('Error fetching orders:', error);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

app.post('/api/orders', async (req, res) => {
  let connection;

  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const { name, email, items } = req.body;

    if (!name || !email || !Array.isArray(items) || items.length === 0) {
      await connection.rollback();
      return res.status(400).json({ error: 'Name, email, and a non-empty items array are required' });
    }

    const normalizedItems = items.map((item) => ({
      id: Number(item.id),
      price: Number(item.price),
      qty: Number(item.qty)
    }));

    for (const item of normalizedItems) {
      if (!Number.isInteger(item.id) || item.id <= 0 || !Number.isFinite(item.price) || item.price < 0 || !Number.isInteger(item.qty) || item.qty <= 0) {
        await connection.rollback();
        return res.status(400).json({ error: 'Each item requires id, price, and a positive qty' });
      }
    }

    const total = normalizedItems.reduce((sum, item) => sum + item.price * item.qty, 0);

    let [existingUsers] = await connection.query('SELECT id FROM users WHERE email = ?', [String(email).trim()]);

    let userId;
    if (existingUsers.length > 0) {
      userId = existingUsers[0].id;
    } else {
      const [userResult] = await connection.query(
        'INSERT INTO users (name, email, role) VALUES (?, ?, ?)',
        [String(name).trim(), String(email).trim(), 'client']
      );
      userId = userResult.insertId;
    }

    const [orderResult] = await connection.query(
      'INSERT INTO orders (user_id, total_amount, status) VALUES (?, ?, ?)',
      [userId, total.toFixed(2), 'pending']
    );

    const orderId = orderResult.insertId;
    const itemRows = normalizedItems.map((item) => [orderId, item.id, item.qty, Number(item.price).toFixed(2)]);

    await connection.query(
      'INSERT INTO order_items (order_id, product_id, quantity, price) VALUES ?',
      [itemRows]
    );

    await connection.commit();

    res.status(201).json({
      orderId,
      status: 'success',
      total: Number(total.toFixed(2))
    });
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }
    console.error('Error creating order:', error);
    res.status(500).json({ error: 'Failed to create order' });
  } finally {
    connection?.release();
  }
});

async function startServer() {
  try {
    await initializeDatabase();
    app.listen(PORT, () => {
      console.log(`SwiftShop server listening on port ${PORT}`);
    });
  } catch (error) {
    console.error('SwiftShop startup failed. Check MySQL credentials and availability.', error);
    await pool.end();
    process.exitCode = 1;
  }
}

startServer();

export default app;
