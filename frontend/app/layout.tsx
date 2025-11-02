export const metadata = {
  title: "Upload",
  description: "Simple black & white upload page",
};

import "./globals.css";
import React from "react";
import { Sidebar, SidebarBody, SidebarLink } from "@/components/ui/sidebar";
import { LayoutDashboard, Search, Sparkles, Plus, UploadCloud } from "lucide-react";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <div className="min-h-screen w-full flex bg-white dark:bg-black text-black dark:text-white">
          <Sidebar>
            <SidebarBody>
              <div className="flex flex-col gap-2">
                <SidebarLink
                  link={{
                    label: "Overview",
                    href: "/overview",
                    icon: <LayoutDashboard size={18} className="shrink-0" />,
                  }}
                />
                <SidebarLink
                  link={{
                    label: "Search",
                    href: "/explore?tab=search",
                    icon: <Search size={18} className="shrink-0" />,
                  }}
                />
                <SidebarLink
                  link={{
                    label: "Analyze",
                    href: "/explore?tab=analyze",
                    icon: <Sparkles size={18} className="shrink-0" />,
                  }}
                />

                <div className="h-px bg-white/20 my-2" />

                <SidebarLink
                  link={{
                    label: "Upload",
                    href: "/",
                    icon: <Plus size={18} className="shrink-0" />,
                  }}
                />
                <SidebarLink
                  link={{
                    label: "Migrate",
                    href: "/migrate",
                    icon: <UploadCloud size={18} className="shrink-0" />,
                  }}
                />
              </div>
            </SidebarBody>
          </Sidebar>
          <div className="flex-1 min-w-0">
            {children}
          </div>
        </div>
      </body>
    </html>
  );
}
