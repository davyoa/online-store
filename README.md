# SwiftShop E-commerce REST API

A production-ready REST API for an e-commerce platform built with Node.js, Express, and MySQL.

## Setup Instructions

### 1. Prerequisites
- Node.js 18+
- MySQL 8.0+

### 2. Database Setup
The server automatically creates the `swiftshop` database, tables, indexes, and seed data when it starts. No manual schema command is required.

### 3. Configure Environment
Edit `.env` with your MySQL credentials:
```env
PORT=5000
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=your_mysql_password
DB_NAME=swiftshop
```

### 4. Install Dependencies
```bash
npm install
```

### 5. Start Server
```bash
# Production
npm start

# Development (with auto-reload)
npm run dev
```

Server runs at `http://localhost:5000`

---

## API Endpoints

### Products

#### GET `/api/products`
Returns all products ordered by ID descending.

```bash
curl http://localhost:3000/api/products
```

#### POST `/api/products`
Create a new product. Required: `title`, `price`. Optional: `category`, `image`, `description`.

```bash
curl -X POST http://localhost:3000/api/products \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Bluetooth Speaker",
    "price": 49.99,
    "category": "Electronics",
    "image": "https://example.com/speaker.jpg",
    "description": "Portable Bluetooth speaker with 12-hour battery"
  }'
```

#### DELETE `/api/products/:id`
Remove a product by ID.

```bash
curl -X DELETE http://localhost:3000/api/products/3
```

---

### Orders

#### GET `/api/orders`
Returns all orders joined with customer details (name, email).

```bash
curl http://localhost:3000/api/orders
```

#### POST `/api/orders`
Handle checkout with transaction safety. Accepts:
```json
{
  "name": "John Doe",
  "email": "john@example.com",
  "items": [
    { "id": 1, "price": 99.99, "qty": 2 },
    { "id": 2, "price": 129.99, "qty": 1 }
  ]
}
```

Logic:
1. Checks if user exists by email; creates new user if not found
2. Calculates grand total from items
3. Creates order in `orders` table
4. Bulk inserts line items into `order_items` table
5. Commits transaction, returns order ID and total

```bash
curl -X POST http://localhost:3000/api/orders \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Jane Smith",
    "email": "jane@example.com",
    "items": [
      { "id": 1, "price": 99.99, "qty": 1 },
      { "id": 2, "price": 129.99, "qty": 2 }
    ]
  }'
```

**Response:**
```json
{
  "orderId": 1,
  "status": "success",
  "total": 359.97
}
```

---

## Database Schema

| Table | Columns |
|-------|---------|
| users | id (PK), name, email (UNIQUE), role ('client'/'admin'), created_at |
| products | id (PK), title, price (DECIMAL), category, image (TEXT), description (TEXT), created_at |
| orders | id (PK), user_id (FK), total_amount (DECIMAL), status ('pending'/'completed'/'cancelled'), created_at |
| order_items | id (PK), order_id (FK), product_id (FK), quantity, price (DECIMAL) |

---

## Seed Data

- **Admin User**: `admin@swiftshop.com` (role: admin)
- **Products**: Wireless Headphones ($99.99), Running Shoes ($129.99)

---

## Project Structure

```
swiftshop-api/
├── package.json
├── .env
├── schema.sql
├── server.js
└── README.md
```

---

## Error Responses

All endpoints return consistent error format:
```json
{
  "error": "Error message description"
}
```

Common status codes:
- `200` - Success
- `201` - Created
- `400` - Bad Request (missing/invalid fields)
- `404` - Not Found
- `500` - Server Error