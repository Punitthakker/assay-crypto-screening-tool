import { z } from "zod";
import { CHAIN_IDS, type ChainId } from "./chains.js";

export const ChainIdSchema = z.enum(CHAIN_IDS as [ChainId, ...ChainId[]]);
export const AssetSchema = z.enum(["USDT", "USDC"]);

export const OriginatorSchema = z
  .object({
    name: z.string().min(1),
    dateOfBirth: z.string().optional(),
    nationality: z.string().length(2).optional(),
    address: z.string().optional(),
    nationalId: z.string().optional(),
    lei: z.string().length(20).optional(),
    isLegalPerson: z.boolean().default(false),
  })
  .strict();

export const ScreenRequestSchema = z
  .object({
    address: z.string().min(20),
    chain: ChainIdSchema,
    asset: AssetSchema,
    /** amount in token units (not base units), optional */
    amount: z.number().positive().optional(),
    direction: z.enum(["inbound", "outbound"]).default("inbound"),
    /** token contract the receiver is about to accept; when given, authenticity is checked */
    tokenContract: z.string().optional(),
    originator: OriginatorSchema.optional(),
    traceDepth: z.number().int().min(0).max(3).optional(),
  })
  .strict();
export type ScreenRequest = z.infer<typeof ScreenRequestSchema>;

export const Verdict = z.enum(["CLEAR", "LOW", "CAUTION", "HIGH", "BLOCK"]);
export type Verdict = z.infer<typeof Verdict>;
export const Confidence = z.enum(["high", "medium", "low"]);
export type Confidence = z.infer<typeof Confidence>;

export const EvidenceSchema = z.object({
  code: z.string(),
  source: z.string(),
  severity: z.enum(["block", "risk", "info"]),
  points: z.number(),
  hop: z.number().int().min(0).default(0),
  summary: z.string(),
  ref: z.string().optional(), // tx hash, list entry, contract call
  checkedAt: z.string(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const CoverageSchema = z.object({
  source: z.string(),
  status: z.enum(["ok", "partial", "unavailable", "not_applicable", "disabled"]),
  detail: z.string().optional(),
  ageHours: z.number().optional(),
});
export type Coverage = z.infer<typeof CoverageSchema>;

export const ReportSchema = z.object({
  reportId: z.string(),
  scoringVersion: z.string(),
  checkedAt: z.string(),
  request: ScreenRequestSchema,
  resolvedToken: z
    .object({
      address: z.string(),
      onChainSymbol: z.string(),
      issuer: z.string(),
      kind: z.string(),
      note: z.string().optional(),
    })
    .optional(),
  score: z.number().min(0).max(100),
  verdict: Verdict,
  confidence: Confidence,
  hardBlock: z.string().optional(),
  flags: z.array(z.string()),
  identity: z.enum(["unverified", "attested", "verified"]),
  evidence: z.array(EvidenceSchema),
  coverage: z.array(CoverageSchema),
  disclaimer: z.string(),
  reportHash: z.string(),
});
export type Report = z.infer<typeof ReportSchema>;

export const DISCLAIMER =
  "Screening support tool. Not legal advice and not a substitute for the regulated entity's own AML/CFT programme or a licensed blockchain analytics provider. Results reflect public data at the time of the check.";
