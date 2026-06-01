/**
 * Lucide-style line icons (1.5px stroke). Ported from the design bundle.
 * Each icon takes a `size` prop (default 16).
 */
import type { SVGProps } from "react";

type IcoProps = SVGProps<SVGSVGElement> & { size?: number };

function Ico({ size = 16, children, ...rest }: IcoProps & { children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...rest}>
      {children}
    </svg>
  );
}

export const IconNewChat = (p: IcoProps) => <Ico {...p}><path d="M12 5v14M5 12h14" /></Ico>;
export const IconSidebar = (p: IcoProps) => <Ico {...p}><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 3v18" /></Ico>;
export const IconSearch = (p: IcoProps) => <Ico {...p}><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></Ico>;
export const IconSparkle = (p: IcoProps) => <Ico {...p}><path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z" /><path d="M19 14l.7 2.1L22 17l-2.3.9L19 20l-.7-2.1L16 17l2.3-.9z" /></Ico>;
export const IconBookmark = (p: IcoProps) => <Ico {...p}><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" /></Ico>;
export const IconList = (p: IcoProps) => <Ico {...p}><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></Ico>;
export const IconUsers = (p: IcoProps) => <Ico {...p}><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></Ico>;
export const IconUpload = (p: IcoProps) => <Ico {...p}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M17 8l-5-5-5 5M12 3v12" /></Ico>;
export const IconDownload = (p: IcoProps) => <Ico {...p}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M7 10l5 5 5-5M12 15V3" /></Ico>;
export const IconAttach = (p: IcoProps) => <Ico {...p}><path d="m21.4 11.05-9.19 9.2a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.65l-9.2 9.2a2 2 0 0 1-2.83-2.83l8.49-8.48" /></Ico>;
export const IconFilter = (p: IcoProps) => <Ico {...p}><path d="M22 3H2l8 9.46V19l4 2v-8.54z" /></Ico>;
export const IconArrowUp = (p: IcoProps) => <Ico {...p}><path d="M12 19V5M5 12l7-7 7 7" /></Ico>;
export const IconChevD = (p: IcoProps) => <Ico {...p}><path d="m6 9 6 6 6-6" /></Ico>;
export const IconClose = (p: IcoProps) => <Ico {...p}><path d="M18 6 6 18M6 6l12 12" /></Ico>;
export const IconCheck = (p: IcoProps) => <Ico {...p}><path d="M20 6 9 17l-5-5" /></Ico>;
export const IconMail = (p: IcoProps) => <Ico {...p}><rect x="2" y="4" width="20" height="16" rx="2" /><path d="m22 7-10 6L2 7" /></Ico>;
export const IconPhone = (p: IcoProps) => <Ico {...p}><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.37 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.33 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" /></Ico>;
export const IconLinkedIn = (p: IcoProps) => <Ico {...p}><path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-4 0v7h-4v-7a6 6 0 0 1 6-6z" /><rect x="2" y="9" width="4" height="12" /><circle cx="4" cy="4" r="2" /></Ico>;
export const IconBolt = (p: IcoProps) => <Ico {...p}><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" /></Ico>;
export const IconNews = (p: IcoProps) => <Ico {...p}><path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2zM18 14h-8M15 18h-5M10 6h8v4h-8z" /></Ico>;
export const IconSheet = (p: IcoProps) => <Ico {...p}><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M3 15h18M9 3v18M15 3v18" /></Ico>;
export const IconSave = (p: IcoProps) => <Ico {...p}><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" /><polyline points="17 21 17 13 7 13 7 21" /><polyline points="7 3 7 8 15 8" /></Ico>;
export const IconBriefcase = (p: IcoProps) => <Ico {...p}><rect x="2" y="7" width="20" height="14" rx="2" /><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" /></Ico>;
export const IconSend = (p: IcoProps) => <Ico {...p}><path d="m22 2-7 20-4-9-9-4z" /><path d="M22 2 11 13" /></Ico>;
export const IconArrowR = (p: IcoProps) => <Ico {...p}><path d="M5 12h14M12 5l7 7-7 7" /></Ico>;
export const IconCalendar = (p: IcoProps) => <Ico {...p}><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></Ico>;
export const IconCopy = (p: IcoProps) => <Ico {...p}><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></Ico>;
export const IconEdit = (p: IcoProps) => <Ico {...p}><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" /></Ico>;
export const IconRetry = (p: IcoProps) => <Ico {...p}><path d="M3 2v6h6" /><path d="M3.5 13a9 9 0 1 0 2.1-9.4L3 8" /></Ico>;
export const IconChevL = (p: IcoProps) => <Ico {...p}><path d="m15 18-6-6 6-6" /></Ico>;
export const IconChevR = (p: IcoProps) => <Ico {...p}><path d="m9 18 6-6-6-6" /></Ico>;
