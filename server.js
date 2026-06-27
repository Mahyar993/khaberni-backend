const express = require("express");
const admin = require("firebase-admin");
require("dotenv").config();

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

console.log("Firebase Project:", serviceAccount.project_id);
console.log("Firebase Email:", serviceAccount.client_email);
console.log("Firebase Key ID:", serviceAccount.private_key_id);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ success: true, message: "Minimal backend running" });
});

app.get("/test-firestore", async (req, res) => {
  try {
    const doc = await admin
      .firestore()
      .collection("app_config")
      .doc("main")
      .get();

    res.json({
      success: true,
      exists: doc.exists,
      data: doc.exists ? doc.data() : null,
    });
  } catch (error) {
    console.error("Firestore test error:", error);
    res.status(500).json({
      success: false,
      code: error.code,
      message: error.message,
      details: error.details,
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
