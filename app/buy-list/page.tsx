"use client";

import { useRouter } from "next/navigation";
import { Card, CardBody, Button, Spinner } from "@heroui/react";
import { useUserRole } from "@/app/hooks/useUserRole";
import BuyListPanel from "@/app/components/buy-list-panel";

export default function BuyListPage() {
  const router = useRouter();
  const { role: userRole, loading } = useUserRole();

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 flex items-center justify-center">
        <Spinner size="lg" color="primary" />
      </div>
    );
  }

  // Restrict to admin/quartermaster
  if (userRole !== "admin" && userRole !== "quartermaster") {
    return (
      <div className="min-h-screen p-6 bg-background">
        <div className="max-w-3xl mx-auto">
          <Card>
            <CardBody className="text-center">
              <h2 className="text-xl font-semibold">Access Denied</h2>
              <p className="mt-2 text-sm text-foreground-500">Only admins and quartermasters can access the Buy List.</p>
              <div className="mt-4">
                <Button onPress={() => router.push("/dashboard")}>Back to Dashboard</Button>
              </div>
            </CardBody>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 p-4 md:p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        <BuyListPanel showHeader />
      </div>
    </div>
  );
}
