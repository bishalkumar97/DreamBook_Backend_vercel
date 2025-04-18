require("dotenv").config({ path: "../.env" }); // Force load from root
const mongoose = require("mongoose");
const cron = require("node-cron");
const logger = require("./config/logger");
const config = require("./config/config");
const amazonService = require("./services/amazon");
const wooCommerceService = require("./services/woocommerce");
const app = require("./app");

// Add email service import
require('./email/sendWelcomeEmails');
logger.info("✅ Email service initialized");
const Order = require("./models/Order");
const routes = require("./routes/v1"); // ✅ Ensure this is correctly imported
const { computeTopRatedAuthors } = require("./helpers/computeAuthors");
const { syncAllBookImages } = require("./services/imageSync.service");
const Book = require("./models/book.model");
const Author = require("./models/author.model");

let server;

// Connect to MongoDB
mongoose
  .connect(config.mongoose.url, config.mongoose.options)
  .then(() => {
    logger.info("✅ Connected to MongoDB");
  })
  .catch((err) => {
    logger.error("❌ MongoDB Connection Error:", err);
  });

// Define the API route for the dashboard
app.get("/api/dashboard", async (req, res) => {
  try {
    const orders = await Order.find().sort({ createdAt: -1 });

    // Calculate platform earnings
    let platformEarnings = orders.reduce((sum, o) => sum + parseFloat(o.total || "0"), 0);
    const totalRoyalty = platformEarnings * 0.1;

    // Get actual counts from DB
    const totalBooks = await Book.countDocuments();
    const totalAuthors = await Author.countDocuments();

    // Calculate total sales
    const totalSale = orders.reduce(
      (sum, o) => sum + (o.line_items?.reduce((acc, item) => acc + (item.quantity || 0), 0) || 0),
      0
    );

    // Group sales by month and book
    const bookSales = {};
    orders.forEach(order => {
      const date = new Date(order.date_created);
      const monthYear = date.toLocaleString('default', { month: 'long', year: 'numeric' });
      
      order.line_items?.forEach(item => {
        if (!bookSales[monthYear]) {
          bookSales[monthYear] = {};
        }
        if (!bookSales[monthYear][item.bookId]) {
          bookSales[monthYear][item.bookId] = {
            name: item.name,
            quantity: 0,
            total: 0
          };
        }
        bookSales[monthYear][item.bookId].quantity += item.quantity;
        bookSales[monthYear][item.bookId].total += parseFloat(item.total);
      });
    });

    const salesReport = orders.map((o) => ({
      platformName: o.source === "amazon" ? "Amazon" : "WooCommerce",
      quantity: (o.line_items || []).reduce((acc, item) => acc + (item.quantity || 0), 0),
      profitsEarned: `₹${o.total}`,
      date: new Date(o.date_created).toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      }),
    }));

    const topRatedAuthors = await computeTopRatedAuthors();

    return res.json({
      status: true,
      data: {
        platformEarnings: `₹${platformEarnings.toFixed(2)}`,
        totalRoyalty: `₹${totalRoyalty.toFixed(2)}`,
        totalBooks,
        totalSale,
        totalAuthors,
        salesReport,
        bookSales,
        topRatedAuthors,
      }
    });
  } catch (error) {
    logger.error("❌ Error building dashboard data:", error);
    res.status(500).json({ status: false, message: "Error building dashboard data" });
  }
});

// API endpoint to fetch orders
app.get("/api/orders", async (req, res) => {
  try {
    // const orders = await Order.find().sort({ date_created: -1 });
    // res.json({ status: true, data: orders });
    const { source } = req.query; // Accept 'source' from query params

    // let filter = {};
    let filter = source ? { source } : {};
    // if (source) filter.source = source; // Apply filter only if 'source' is provided
    console.log("Fetching orders with filter:", filter); // Debugging log
    const orders = await Order.find(filter).sort({ date_created: -1 });

    if (orders.length === 0) {
      return res.status(404).json({ status: false, message: "No orders found" });
    }

    res.json({ status: true, data: orders });
  } catch (error) {
    logger.error("❌ Error fetching orders:", error);
    res.status(500).json({ status: false, message: "Error fetching orders" });
  }
});

// Cron job to sync orders every hour
cron.schedule("0 * * * *", async () => {
  logger.info("🕒 Running order sync...");
  const amazonOrders = await amazonService.fetchAmazonOrders();
  await amazonService.saveAmazonOrders(amazonOrders);
  await wooCommerceService.fetchOrders();
  logger.info("✅ Orders synced.");
});

// Start the server
server = app.listen(config.port, async () => {
  logger.info(`🚀 Server running on port ${config.port}`);
  const amazonOrders = await amazonService.fetchAmazonOrders();
  await amazonService.saveAmazonOrders(amazonOrders);
  await wooCommerceService.fetchOrders();
  await syncAllBookImages();
});

// Graceful exit handlers
const exitHandler = () => {
  if (server) {
    server.close(() => {
      logger.info("Server closed");
      process.exit(1);
    });
  } else {
    process.exit(1);
  }
};

const unexpectedErrorHandler = (error) => {
  logger.error(error);
  exitHandler();
};

process.on("uncaughtException", unexpectedErrorHandler);
process.on("unhandledRejection", unexpectedErrorHandler);
process.on("SIGTERM", () => {
  logger.info("SIGTERM received");
  if (server) {
    server.close();
  }
});

// Sync orders every 30 minutes
cron.schedule("*/30 * * * *", async () => {
  try {
    logger.info("🔄 Starting scheduled order sync...");
    
    // Check WooCommerce configuration
    if (!process.env.WOOCOMMERCE_API_URL) {
      logger.error("❌ WooCommerce API URL not configured");
      return;
    }
    
    // Sync WooCommerce orders
    await wooCommerceService.fetchOrders().catch(error => {
      logger.error("❌ WooCommerce sync failed:", error.message);
    });
    
    // Sync Amazon orders
    const amazonOrders = await amazonService.fetchAmazonOrders().catch(error => {
      logger.error("❌ Amazon sync failed:", error.message);
    });
    
    if (amazonOrders?.length) {
      await amazonService.saveAmazonOrders(amazonOrders);
    }
    
    logger.info("✅ Scheduled order sync completed");
  } catch (error) {
    logger.error("❌ Error during scheduled sync:", error);
  }
});

// Add this to your existing cron jobs
cron.schedule("0 */6 * * *", async () => {
  logger.info("🔄 Starting scheduled image sync...");
  await syncAllBookImages();
});
