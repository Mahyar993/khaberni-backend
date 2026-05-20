const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;
const axios = require("axios");
const cheerio = require("cheerio");
require("dotenv").config();

let serviceAccount;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
  serviceAccount = require("./firebase-service-account.json");
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    message: "Khaberni Backend is running",
    firebase: "connected",
    cloudinary: "ready",
  });
});

app.post("/api/admin/login", async (req, res) => {
  try {
    const { password } = req.body;

    if (!password) {
      return res.status(400).json({
        success: false,
        message: "Password is required",
      });
    }

    if (password !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({
        success: false,
        message: "Invalid admin password",
      });
    }

    const token = jwt.sign(
      { role: "admin" },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.json({
      success: true,
      message: "Login successful",
      token,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Login failed",
      error: error.message,
    });
  }
});

app.post("/api/notifications/send", async (req, res) => {
  try {
    const { title, body } = req.body;

    if (!title || !body) {
      return res.status(400).json({
        success: false,
        message: "title and body are required",
      });
    }

    await admin.messaging().send({
      topic: "all",
      notification: {
        title,
        body,
      },
      data: {
        title,
        body,
      },
    });

    return res.json({
      success: true,
      message: "Notification sent successfully",
    });
  } catch (error) {
    console.error("Notification error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to send notification",
      error: error.message,
    });
  }
});

app.post("/api/upload-image", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "No image uploaded",
      });
    }

    const uploadResult = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: "khaberni_ads",
          resource_type: "image",
        },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      );

      stream.end(req.file.buffer);
    });

    return res.json({
      success: true,
      message: "Image uploaded successfully",
      imageUrl: uploadResult.secure_url,
    });
  } catch (error) {
    console.error("Upload error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to upload image",
      error: error.message,
    });
  }
});

app.post("/api/analytics/app-open", async (req, res) => {
  try {
    const { deviceId } = req.body;

    if (!deviceId) {
      return res.status(400).json({
        success: false,
        message: "deviceId is required",
      });
    }

    const now = new Date();

    await admin.firestore().collection("analytics_app_opens").add({
      deviceId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      year: now.getFullYear(),
      month: now.getMonth() + 1,
      day: now.getDate(),
    });

    await admin.firestore().collection("analytics_devices").doc(deviceId).set(
      {
        deviceId,
        lastOpenAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return res.json({
      success: true,
      message: "App open recorded",
    });
  } catch (error) {
    console.error("Analytics error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to record app open",
      error: error.message,
    });
  }
});

app.get("/api/admin/stats", async (req, res) => {
  try {
    const now = new Date();

    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;
    const currentDay = now.getDate();

    const devicesSnapshot = await admin
      .firestore()
      .collection("analytics_devices")
      .get();

    const todayOpensSnapshot = await admin
      .firestore()
      .collection("analytics_app_opens")
      .where("year", "==", currentYear)
      .where("month", "==", currentMonth)
      .where("day", "==", currentDay)
      .get();

    const monthOpensSnapshot = await admin
      .firestore()
      .collection("analytics_app_opens")
      .where("year", "==", currentYear)
      .where("month", "==", currentMonth)
      .get();

    const yearOpensSnapshot = await admin
      .firestore()
      .collection("analytics_app_opens")
      .where("year", "==", currentYear)
      .get();

    const adsSnapshot = await admin.firestore().collection("ads").get();

    let featuredAdsCount = 0;

    adsSnapshot.forEach((doc) => {
      const ad = doc.data();

      if (ad.isFeatured === true) {
        featuredAdsCount++;
      }
    });

    return res.json({
      success: true,
      stats: {
        estimatedDownloads: devicesSnapshot.size,
        appOpensToday: todayOpensSnapshot.size,
        appOpensThisMonth: monthOpensSnapshot.size,
        appOpensThisYear: yearOpensSnapshot.size,
        totalAds: adsSnapshot.size,
        featuredAds: featuredAdsCount,
      },
    });
  } catch (error) {
    console.error("Stats error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to load stats",
      error: error.message,
    });
  }
});

app.get("/api/app-config", async (req, res) => {
  try {
    const configDoc = await admin
      .firestore()
      .collection("app_config")
      .doc("main")
      .get();

    if (!configDoc.exists) {
      return res.json({
        success: true,
        config: {
          isAppEnabled: true,
          maintenanceMessage: "",
          minimumRequiredVersion: 1,
          latestVersion: 1,
          updateMessage: "يرجى تحديث التطبيق إلى آخر نسخة للاستمرار.",
          updateUrl: "",
        },
      });
    }

    const configData = configDoc.data();

    return res.json({
      success: true,
      config: {
        isAppEnabled: configData.isAppEnabled !== false,
        maintenanceMessage: configData.maintenanceMessage || "",
        minimumRequiredVersion: configData.minimumRequiredVersion || 1,
        latestVersion: configData.latestVersion || 1,
        updateMessage:
          configData.updateMessage ||
          "يرجى تحديث التطبيق إلى آخر نسخة للاستمرار.",
        updateUrl: configData.updateUrl || "",
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to load app config",
      error: error.message,
    });
  }
});

app.post("/api/admin/app-config", async (req, res) => {
  try {
    const {
      isAppEnabled,
      maintenanceMessage,
      minimumRequiredVersion,
      latestVersion,
      updateMessage,
      updateUrl,
    } = req.body;

    await admin
      .firestore()
      .collection("app_config")
      .doc("main")
      .set(
        {
          isAppEnabled: isAppEnabled !== false,
          maintenanceMessage: maintenanceMessage || "",
          minimumRequiredVersion: Number(minimumRequiredVersion) || 1,
          latestVersion: Number(latestVersion) || 1,
          updateMessage:
            updateMessage || "يرجى تحديث التطبيق إلى آخر نسخة للاستمرار.",
          updateUrl: updateUrl || "",
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

    return res.json({
      success: true,
      message: "App config updated successfully",
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to update app config",
      error: error.message,
    });
  }
});
app.get("/api/jobs/update-sp-today", async (req, res) => {
  const response = await axios.get(
  "https://sp-today.com/currency/us-dollar",
  {
  headers: {
  "User-Agent":
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",

  "Accept":
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",

  "Accept-Language":
  "ar,en-US;q=0.9,en;q=0.8",

  "Referer":
  "https://sp-today.com/",

  "Origin":
  "https://sp-today.com"
  },

  timeout: 20000
  }
  )
    });

    const $ = cheerio.load(response.data);
    const pageText = $("body").text().replace(/\s+/g, " ");

    return res.json({
      success: true,
      message: "SP Today page loaded",
      preview: pageText.substring(0, 2000),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to load SP Today",
      error: error.message,
    });
  }
});
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});