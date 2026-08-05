/** Wire types for the existing CRM API (mirrors shared/src/index.ts). */

export type CrmStage = "new" | "contacted" | "replied" | "meeting" | "closed";
export type CrmTemp = "hot" | "warm" | "cold";

export interface CrmStageDef {
  id: string;
  label: string;
  color: string;
  tint?: string;
}

export interface CrmColumnDef {
  id: string;
  builtin: boolean;
  label: string;
  type: string;
  width?: string;
  hidden?: boolean;
}

export interface CrmBoard {
  id: string;
  name: string;
  emoji?: string;
  contactCount?: number;
  stages?: CrmStageDef[] | null;
  columns?: CrmColumnDef[] | null;
}

export interface CrmContact {
  id: string;
  boardId: string;
  name: string;
  title: string | null;
  company: string | null;
  email: string | null;
  phone: string | null;
  linkedin: string | null;
  stage: CrmStage;
  temp: CrmTemp;
  sent: number;
  opens: number;
  replies: number;
  lastTouchAt: string | null;
  lastTouchDirection: "in" | "out" | null;
  nextStep: string | null;
  source: string | null;
  notes: string | null;
  customFields?: Record<string, string>;
  positionIdx: number;
  createdAt: string;
  updatedAt: string;
}
