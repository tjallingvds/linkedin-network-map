/**
 * Thin wrapper around the Apollo integration: search + match.
 */
import { Router } from "express";
import { z } from "zod";
import { apolloConfigured, apolloPeopleSearch, apolloMatchPerson } from "../integrations/apollo.js";

const router = Router();

router.get("/status", (_req, res) => {
  res.json({ configured: apolloConfigured() });
});

router.post("/search", async (req, res) => {
  if (!apolloConfigured()) return res.status(501).json({ error: "apollo_not_configured" });
  const parsed = z
    .object({
      q: z.string().optional(),
      company: z.string().optional(),
      title: z.string().optional(),
      page: z.number().int().min(1).max(500).optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });
  const result = await apolloPeopleSearch(parsed.data);
  res.json(result);
});

router.post("/match", async (req, res) => {
  if (!apolloConfigured()) return res.status(501).json({ error: "apollo_not_configured" });
  const parsed = z
    .object({
      firstName: z.string().optional(),
      lastName: z.string().optional(),
      name: z.string().optional(),
      email: z.string().optional(),
      domain: z.string().optional(),
      organizationName: z.string().optional(),
      linkedinUrl: z.string().optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });
  const person = await apolloMatchPerson(parsed.data);
  res.json({ person });
});

export default router;
