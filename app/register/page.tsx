'use client';
import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, Input, Card, CardBody, CardHeader, Divider } from '@heroui/react';
import { EyeSlashFilledIcon, EyeFilledIcon } from '@heroui/shared-icons';
import { UserPlus } from 'lucide-react';
import { createUserWithEmailAndPassword, updateProfile } from 'firebase/auth';
import { FirebaseError } from 'firebase/app';
import { auth, db } from '@/firebase';
import { doc, setDoc } from 'firebase/firestore';
import type { User } from '@/app/types';

export default function RegisterPage() {
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const [isConfirmVisible, setIsConfirmVisible] = useState(false);
  const [error, setError] = useState('');
  const router = useRouter();

  const toggleVisibility = () => setIsVisible(!isVisible);
  const toggleConfirmVisibility = () => setIsConfirmVisible(!isConfirmVisible);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!fullName.trim()) {
      setError('Full name is required');
      return;
    }

    if (!email.trim()) {
      setError('Email is required');
      return;
    }

    if (!password) {
      setError('Password is required');
      return;
    }

    if (!confirmPassword) {
      setError('Please confirm your password');
      return;
    }

    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    if (password.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }

    setLoading(true);
    try {
      // Create user in Firebase Authentication
      const userCredential = await createUserWithEmailAndPassword(auth, email, password);
      const firebaseUser = userCredential.user;

      // Update user profile with full name
      await updateProfile(firebaseUser, {
        displayName: fullName,
      });

      // Store user data in Firestore
      const userData: User = {
        id: firebaseUser.uid,
        fullName,
        email,
        role: 'member',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await setDoc(doc(db, 'users', firebaseUser.uid), userData);

      // Redirect to login page
      router.push('/login');
    } catch (err: unknown) {
      console.error('Registration error:', err);
      if (err instanceof FirebaseError) {
        if (err.code === 'auth/email-already-in-use') {
          setError('Email is already in use');
        } else if (err.code === 'auth/invalid-email') {
          setError('Invalid email address');
        } else {
          setError(err.message || 'Failed to create account');
        }
      } else {
        setError('Failed to create account');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 p-4">
      <Card className="max-w-md w-full shadow-lg bg-white/80 dark:bg-slate-800/80 border border-gray-200/70 dark:border-slate-700 rounded-xl">
        <CardHeader className="flex flex-col gap-2 p-6">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
            <UserPlus className="text-indigo-600" size={22} />
            Create Account
          </h1>
          <p className="text-gray-500 dark:text-gray-400 text-sm">Join BMRC Logistics today</p>
        </CardHeader>
        <Divider />
        <CardBody className="p-8 gap-6">
          {error && (
            <div className="w-full p-4 bg-red-100 dark:bg-red-900/30 border-l-4 border-red-500 dark:border-red-600 rounded-2xl">
              <p className="text-red-700 dark:text-red-400 font-medium">{error}</p>
            </div>
          )}
          <form onSubmit={handleSubmit} className="space-y-6">
            <Input
              type="text"
              label="Full Name"
              placeholder="Enter your full name"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              variant="bordered"
              size="lg"
              className="w-full"
            />
            <Input
              type="email"
              label="Email"
              placeholder="Enter your email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              variant="bordered"
              size="lg"
              className="w-full"
            />
            <Input
              label="Password"
              placeholder="Enter your password"
              type={isVisible ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              variant="bordered"
              size="lg"
              endContent={
                <button className="focus:outline-none" type="button" onClick={toggleVisibility}>
                  {isVisible ? (
                    <EyeSlashFilledIcon className="text-2xl text-default-400" />
                  ) : (
                    <EyeFilledIcon className="text-2xl text-default-400" />
                  )}
                </button>
              }
            />
            <Input
              label="Confirm Password"
              placeholder="Confirm your password"
              type={isConfirmVisible ? "text" : "password"}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              variant="bordered"
              size="lg"
              endContent={
                <button className="focus:outline-none" type="button" onClick={toggleConfirmVisibility}>
                  {isConfirmVisible ? (
                    <EyeSlashFilledIcon className="text-2xl text-default-400" />
                  ) : (
                    <EyeFilledIcon className="text-2xl text-default-400" />
                  )}
                </button>
              }
            />
            <Button
              type="submit"
              isLoading={loading}
              color="primary"
              className="w-full h-12 font-semibold"
              size="lg"
            >
              {loading ? 'Creating Account...' : 'Sign Up'}
            </Button>
          </form>
          <div className="text-center text-sm">
            <p className="text-gray-600 dark:text-gray-400">
              Already have an account?{' '}
              <Link href="/login" className="text-indigo-600 dark:text-indigo-400 font-semibold hover:underline">
                Sign In
              </Link>
            </p>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
