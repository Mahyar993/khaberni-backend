const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;
const axios = require("axios");
const csv = require("csv-parser");
const { Readable } = require("stream");
const cheerio = require("cheerio");
const cron = require("node-cron");
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

function verifyAdminToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    const token = authHeader.split(" ")[1];
if(
 token===
 process.env.INTERNAL_JOB_TOKEN
){

 req.admin={
   role:"internal"
 };

 return next();

}
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (!decoded || decoded.role !== "admin") {
      return res.status(403).json({
        success: false,
        message: "Forbidden",
      });
    }

    req.admin = decoded;

    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired token",
    });
  }
}

async function writeAdminLog(action, details = {}) {
  try {
    await admin.firestore().collection("admin_logs").add({
      action,
      details,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (error) {
    console.error("Failed to write admin log:", error.message);
  }
}

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

app.post("/api/notifications/send", verifyAdminToken, async (req, res) => {
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
    await writeAdminLog("send_notification", {
      title,
      body,
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

app.post("/api/upload-image", verifyAdminToken, upload.single("image"), async (req, res) => {
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

app.get("/api/admin/stats", verifyAdminToken, async (req, res) => {
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

app.post("/api/admin/app-config", verifyAdminToken, async (req, res) => {
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
    await writeAdminLog("update_app_config", {
      isAppEnabled,
      minimumRequiredVersion,
      latestVersion,
    });
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
app.get("/api/jobs/update-currencies", verifyAdminToken, async (req, res) => {
  try {
    const response = await axios.get(
      "https://lirascope.syria-cloud.sy/api/v1/rates/latest?currencies=USD,EUR,TRY&lang=ar",
      { timeout: 20000 }
    );

    const marketRates = response.data.marketRates || [];

    const findRate = (currency) => {
      return marketRates.find((item) => item.currency === currency);
    };

    const multiplyRate = (value) => {
      return Math.round(Number(value) * 100);
    };

    const usd = findRate("USD");
    const eur = findRate("EUR");
    const tryRate = findRate("TRY");

    if (!usd || !eur || !tryRate) {
      return res.status(400).json({
        success: false,
        message: "Some currency rates were not found",
        available: marketRates.map((item) => item.currency),
      });
    }

    const db = admin.firestore();

    const updateCurrency = async (id, title, rate, order) => {
      const buy = multiplyRate(rate.buy);
      const sell = multiplyRate(rate.sell);

      const docRef = db
        .collection("sections")
        .doc("currencies")
        .collection("items")
        .doc(id);

      const oldDoc = await docRef.get();
      const oldContent = oldDoc.exists ? oldDoc.data().content || "" : "";

      const newContent = `شراء : ${buy} - بيع : ${sell}`;
      const hasChanged = oldContent !== newContent;

      await docRef.set(
        {
          title,
          content: newContent,
          order,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          lastCheckedAt: admin.firestore.FieldValue.serverTimestamp(),
          source: "LiraScope",
          buy,
          sell,
        },
        { merge: true }
      );

      if (hasChanged) {
        await admin.messaging().send({
          topic: "all",
          notification: {
            title: title,
            body: `تحديث جديد للأسعار:\nشراء : ${buy} - بيع : ${sell}`,
          },
          data: {
            title: title,
            body: `تحديث جديد للأسعار:\nشراء : ${buy} - بيع : ${sell}`,
          },
        });
      }

      return {
        id,
        title,
        buy,
        sell,
        hasChanged,
      };
    };

    const results = [];

    results.push(await updateCurrency("dollar", "الدولار", usd, 1));
    results.push(await updateCurrency("euro", "اليورو", eur, 2));
    results.push(await updateCurrency("Turkish", "ليرة تركية", tryRate, 3));

    if (req.query.cron === "1") {
      return res.status(200).type("text/plain").send("OK");
    }

    return res.json({
      success: true,
      message: "OK",
      changed: results.filter((item) => item.hasChanged).length,
      checked: results.length,
    });
  } catch (error) {
    if (req.query.cron === "1") {
      return res.status(500).type("text/plain").send("ERROR");
    }

    return res.status(500).json({
      success: false,
      message: "Failed to update currencies",
      error: error.message,
    });
  }
});
app.get("/api/jobs/update-daily-sheet", verifyAdminToken, async (req, res) => {

  try {

    const SHEET_URL =
      "https://docs.google.com/spreadsheets/d/e/2PACX-1vQ7TGi4diWL6deY9jHCQIDXx3itWOuUo1BEZyIMZd-iYtRCP7R2NrID4lT5mayirzo5L7ggOtEtxbgq/pub?output=csv";

    const response = await axios.get(SHEET_URL,{
      timeout:20000
    });

    const rows = [];

    await new Promise((resolve,reject)=>{

      Readable
        .from(response.data)
        .pipe(csv())
        .on("data",(data)=>{

          rows.push(data);

        })
        .on("end",resolve)
        .on("error",reject);

    });

    const today =
      new Date()
        .toISOString()
        .split("T")[0];

    const todayRows =
      rows.filter(row => {

        return (
          row.date === today &&
          row.isActive?.toLowerCase() === "true"
        );

      });

    const db = admin.firestore();

    let updated = 0;

    for(const row of todayRows){

      const sectionId =
        row.sectionId;

      const itemId =
        row.itemId;

      if(
        !sectionId ||
        !itemId
      ){
        continue;
      }

      await db
        .collection("sections")
        .doc(sectionId)
        .collection("items")
        .doc(itemId)
        .set({

          title:
            row.title || "",

          content:
            row.content || "",

          order:
            Number(row.order)||999,

          updatedAt:
            admin.firestore.FieldValue.serverTimestamp(),

          source:
            "GoogleSheet"

        },{
          merge:true
        });

      updated++;

    }

    if(req.query.cron==="1"){

      return res
        .status(200)
        .type("text/plain")
        .send("OK");

    }

    return res.json({

      success:true,
      updated,
      totalToday:
        todayRows.length,
      today

    });

  } catch(error){

    console.error(error);

    if(req.query.cron==="1"){

      return res
        .status(500)
        .type("text/plain")
        .send("ERROR");

    }

    return res.status(500).json({

      success:false,
      error:error.message

    });

  }

});
app.get("/api/jobs/send-water-notifications", verifyAdminToken, async (req, res) => {
  try {
    const db = admin.firestore();

    const snapshot = await db
      .collection("sections")
      .doc("Water")
      .collection("items")
      .orderBy("order", "asc")
      .get();

    let sent = 0;

    for (const doc of snapshot.docs) {
      const item = doc.data();

      const title = item.title || "";
      const content = item.content || "";

      if (!title || !content) {
        continue;
      }

      await admin.messaging().send({
        topic: "all",
        notification: {
          title: title,
          body: content,
        },
        data: {
          title: title,
          body: content,
        },
      });

      sent++;
    }

    if (req.query.cron === "1") {
      return res.status(200).type("text/plain").send("OK");
    }

    return res.json({
      success: true,
      message: "Water notifications sent",
      sent,
    });
  } catch (error) {
    if (req.query.cron === "1") {
      return res.status(500).type("text/plain").send("ERROR");
    }

    return res.status(500).json({
      success: false,
      message: "Failed to send water notifications",
      error: error.message,
    });
  }
});
app.get(
  "/api/admin/sections",
  verifyAdminToken,
  async (req, res) => {

    try {

      const snapshot =
        await admin
          .firestore()
          .collection("sections")
          .get();

      const sections =
        snapshot.docs.map(doc => ({

          id: doc.id,
          ...doc.data()

        }));

      return res.json({

        success:true,
        sections

      });

    } catch(error){

      return res.status(500).json({

        success:false,
        error:error.message

      });

    }

});

app.get(
  "/api/admin/sections/:sectionId/items",
  verifyAdminToken,
  async(req,res)=>{

    try{

      const snapshot =
        await admin
          .firestore()
          .collection("sections")
          .doc(req.params.sectionId)
          .collection("items")
          .orderBy("order","asc")
          .get();

      const items =
        snapshot.docs.map(doc=>({

          id:doc.id,
          ...doc.data()

        }));

      return res.json({

        success:true,
        items

      });

    }catch(error){

      return res.status(500).json({

        success:false,
        error:error.message

      });

    }

});

app.post(
  "/api/admin/sections/:sectionId/items",
  verifyAdminToken,
  async(req,res)=>{

    try{

      const {

        title,
        content,
        order,
        icon,
        color

      } = req.body;

      const docRef =
        admin
          .firestore()
          .collection("sections")
          .doc(req.params.sectionId)
          .collection("items")
          .doc();

      await docRef.set({

        title:title||"",
        content:content||"",
        order:Number(order)||999,
        icon:icon||"",
        color:color||"",
        isActive:true,

        createdAt:
          admin.firestore.FieldValue.serverTimestamp(),

        updatedAt:
          admin.firestore.FieldValue.serverTimestamp()

      });

      await writeAdminLog(

        "create_item",

        {

          section:
            req.params.sectionId,

          title

        }

      );

      return res.json({

        success:true,
        id:docRef.id

      });

    }catch(error){

      return res.status(500).json({

        success:false,
        error:error.message

      });

    }

});

app.put(
  "/api/admin/sections/:sectionId/items/:itemId",
  verifyAdminToken,
  async(req,res)=>{

    try{

      await admin
        .firestore()
        .collection("sections")
        .doc(req.params.sectionId)
        .collection("items")
        .doc(req.params.itemId)
        .set({

          ...req.body,

          updatedAt:
            admin.firestore.FieldValue.serverTimestamp()

        },{

          merge:true

        });

      await writeAdminLog(

        "update_item",

        {

          section:
            req.params.sectionId,

          item:
            req.params.itemId

        }

      );

      return res.json({

        success:true

      });

    }catch(error){

      return res.status(500).json({

        success:false,
        error:error.message

      });

    }

});

app.delete(
  "/api/admin/sections/:sectionId/items/:itemId",
  verifyAdminToken,
  async(req,res)=>{

    try{

      await admin
        .firestore()
        .collection("sections")
        .doc(req.params.sectionId)
        .collection("items")
        .doc(req.params.itemId)
        .delete();

      await writeAdminLog(

        "delete_item",

        {

          section:
            req.params.sectionId,

          item:
            req.params.itemId

        }

      );

      return res.json({

        success:true

      });

    }catch(error){

      return res.status(500).json({

        success:false,
        error:error.message

      });

    }

});
const PORT = process.env.PORT || 5000;
async function runCurrenciesJob() {

  try {

    console.log("Running currencies update");

 await axios.get(
   `http://localhost:${PORT}/api/jobs/update-currencies`,
   {
     headers: {
       Authorization: `Bearer ${process.env.INTERNAL_JOB_TOKEN}`,
     },
   }
 );

  } catch(error){

    console.error(
      "Currencies scheduler error:",
      error.message
    );

  }

}

async function runDailySheetJob() {

  try {

    console.log("Running daily sheet update");

await axios.get(
  `http://localhost:${PORT}/api/jobs/update-daily-sheet`,
  {
    headers: {
      Authorization: `Bearer ${process.env.INTERNAL_JOB_TOKEN}`,
    },
  }
);

  } catch(error){

    console.error(
      "Daily sheet scheduler error:",
      error.message
    );

  }

}

async function runWaterNotificationJob() {

  try {

    console.log(
      "Running water notifications"
    );

await axios.get(
  `http://localhost:${PORT}/api/jobs/send-water-notifications`,
  {
    headers: {
      Authorization: `Bearer ${process.env.INTERNAL_JOB_TOKEN}`,
    },
  }
);

  } catch(error){

    console.error(
      "Water notification scheduler error:",
      error.message
    );

  }

}

cron.schedule(
  "0 6 * * *",
  async ()=>{

    await runDailySheetJob();

  },
  {
    timezone:"Asia/Damascus"
  }
);

cron.schedule(
  "0 9 * * *",
  async ()=>{

    await runWaterNotificationJob();

  },
  {
    timezone:"Asia/Damascus"
  }
);

cron.schedule(
  "*/30 6-18 * * *",
  async ()=>{

    await runCurrenciesJob();

  },
  {
    timezone:"Asia/Damascus"
  }
);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});