'use client';
import Link from 'next/link';
import { Button, Card, CardBody, CardHeader } from '@heroui/react';

export default function Home() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 p-4">
      <main className="max-w-3xl w-full">
        <Card className="shadow-lg dark:bg-slate-800 dark:border-slate-700 rounded-3xl">
          <CardHeader className="flex flex-col gap-3 p-6 bg-gradient-to-r from-indigo-600 to-blue-600 dark:from-indigo-700 dark:to-blue-700 rounded-t-3xl">
            <h1 className="text-4xl font-bold text-white">BMRC Logistics</h1>
            <p className="text-indigo-100">Efficient logistics management for your business</p>
          </CardHeader>
          <CardBody className="p-8 gap-6 rounded-b-3xl">
            <div className="space-y-4">
              <h2 className="text-2xl font-semibold text-gray-800 dark:text-white">Welcome to your Dashboard</h2>
              <p className="text-gray-600 dark:text-gray-400 leading-relaxed">
                BMRC Logistics provides comprehensive solutions for tracking, managing, and optimizing your supply chain operations. 
                Sign in to access your account and manage shipments, inventory, and more.
              </p>
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 my-6">
              <div className="p-4 bg-blue-50 dark:bg-blue-900/30 rounded-2xl dark:border dark:border-blue-800">
                <h3 className="font-semibold text-blue-900 dark:text-blue-300 mb-2">Track Shipments</h3>
                <p className="text-sm text-blue-700 dark:text-blue-200">Real-time tracking of your deliveries</p>
              </div>
              <div className="p-4 bg-green-50 dark:bg-green-900/30 rounded-2xl dark:border dark:border-green-800">
                <h3 className="font-semibold text-green-900 dark:text-green-300 mb-2">Manage Inventory</h3>
                <p className="text-sm text-green-700 dark:text-green-200">Control stock levels efficiently</p>
              </div>
              <div className="p-4 bg-purple-50 dark:bg-purple-900/30 rounded-2xl dark:border dark:border-purple-800">
                <h3 className="font-semibold text-purple-900 dark:text-purple-300 mb-2">Analytics</h3>
                <p className="text-sm text-purple-700 dark:text-purple-200">Insights into your operations</p>
              </div>
            </div>

            <div className="flex gap-4 pt-4 items-center justify-center">
              <Link href="/login" className="flex-1 max-w-xs">
                <Button 
                  as="div"
                  className="w-full h-12 bg-indigo-600 hover:bg-indigo-700 dark:bg-indigo-700 dark:hover:bg-indigo-600 text-white font-semibold rounded-2xl transition-colors cursor-pointer flex items-center justify-center"
                >
                  Sign In
                </Button>
              </Link>
              <Button 
                className="flex-1 max-w-xs h-12 border-2 border-indigo-600 dark:border-indigo-500 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 font-semibold rounded-2xl transition-colors flex items-center justify-center"
              >
                Learn More
              </Button>
            </div>
          </CardBody>
        </Card>
      </main>
    </div>
  );
}
