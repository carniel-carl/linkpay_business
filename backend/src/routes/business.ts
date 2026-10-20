import { Router } from "express";
import {
  addPerson,
  createBusiness,
  deleteDocument,
  downloadDocument,
  getMyBusiness,
  removePerson,
  submitForReview,
  updateBusiness,
  updatePerson,
  uploadDocument,
} from "../controllers/business";
import { requireAuth } from "../middleware/auth";
import { uploadSingle } from "../middleware/upload";

export const businessRouter = Router();

businessRouter.use(requireAuth);

businessRouter.post("/", createBusiness);
businessRouter.get("/", getMyBusiness);
businessRouter.patch("/", updateBusiness);

businessRouter.post("/people", addPerson);
businessRouter.patch("/people/:personId", updatePerson);
businessRouter.delete("/people/:personId", removePerson);

businessRouter.post("/documents", uploadSingle("file"), uploadDocument);
businessRouter.get("/documents/:documentId/file", downloadDocument);
businessRouter.delete("/documents/:documentId", deleteDocument);

businessRouter.post("/submit", submitForReview);
