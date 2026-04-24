const mongoose = require('mongoose');

let isConnected = false;

const connectDB = async () => {
  if (isConnected) return;

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI is not defined in environment variables');
  }

  try {
    const conn = await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });

    isConnected = true;
    console.log(`[DB] ✅ MongoDB connected: ${conn.connection.host}`);

    mongoose.connection.on('disconnected', () => {
      isConnected = false;
      console.warn('[DB] ⚠️  MongoDB disconnected');
    });

    mongoose.connection.on('error', (err) => {
      console.error('[DB] ❌ MongoDB error:', err.message);
    });

  } catch (err) {
    console.error('[DB] ❌ Connection failed:', err.message);
    throw err;
  }
};

module.exports = connectDB;
