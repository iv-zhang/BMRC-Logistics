'use client';
import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Card,
  CardBody,
  CardHeader,
  Button,
  Chip,
  Divider,
  Spinner
} from '@heroui/react';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from '@/firebase';
import type { User } from '@/app/types';

export default function ProfilePage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      if (!currentUser) {
        router.push('/login');
        return;
      }

      // Fetch user data from Firestore
      try {
        const userRef = doc(db, 'users', currentUser.uid);
        const userSnap = await getDoc(userRef);

        if (userSnap.exists()) {
          const userData = userSnap.data();
          setUser({
            id: userData.id,
            fullName: userData.fullName,
            email: userData.email,
            role: userData.role,
            createdAt: userData.createdAt?.toDate() || new Date(),
            updatedAt: userData.updatedAt?.toDate() || new Date(),
          });
        }
      } catch (error) {
        console.error('Error fetching user data:', error);
      } finally {
        setLoading(false);
      }
    });

    return () => unsubscribe();
  }, [router]);

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Spinner size="lg" color="primary" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Card className="max-w-md">
          <CardBody>
            <p className="text-center">Unable to load profile information.</p>
            <Button
              color="primary"
              onClick={() => router.push('/dashboard')}
              className="mt-4"
            >
              Return to Dashboard
            </Button>
          </CardBody>
        </Card>
      </div>
    );
  }

  const getRoleColor = (role: string) => {
    switch (role) {
      case 'admin':
        return 'danger';
      case 'FTO':
        return 'warning';
      case 'quartermaster':
        return 'secondary';
      default:
        return 'primary';
    }
  };

  const getRoleLabel = (role: string) => {
    switch (role) {
      case 'FTO':
        return 'Field Training Officer';
      case 'quartermaster':
        return 'Quartermaster';
      default:
        return role.charAt(0).toUpperCase() + role.slice(1);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-slate-900 py-8 px-4">
      <div className="max-w-2xl mx-auto">
        <Card className="shadow-lg">
          <CardHeader className="pb-0">
            <div className="flex items-center gap-4">
              <div className="w-16 h-16 bg-indigo-600 rounded-full flex items-center justify-center text-white text-2xl font-bold">
                {user.fullName.charAt(0).toUpperCase()}
              </div>
              <div>
                <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
                  Profile
                </h1>
                <p className="text-gray-600 dark:text-gray-400">
                  Your account information
                </p>
              </div>
            </div>
          </CardHeader>

          <CardBody className="space-y-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Full Name
              </label>
              <div className="p-3 bg-gray-50 dark:bg-slate-800 rounded-lg border">
                <p className="text-gray-900 dark:text-white font-medium">
                  {user.fullName}
                </p>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Email Address
              </label>
              <div className="p-3 bg-gray-50 dark:bg-slate-800 rounded-lg border">
                <p className="text-gray-900 dark:text-white font-medium">
                  {user.email}
                </p>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Role
              </label>
              <div className="flex items-center gap-3">
                <Chip
                  color={getRoleColor(user.role)}
                  variant="flat"
                  size="lg"
                >
                  {getRoleLabel(user.role)}
                </Chip>
              </div>
            </div>

            <Divider />

            <div className="flex gap-3">
              <Button
                color="primary"
                onClick={() => router.push('/dashboard')}
              >
                Back to Dashboard
              </Button>
            </div>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}