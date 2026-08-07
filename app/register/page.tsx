'use client';
import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, Input } from '@heroui/react';
import { EyeSlashFilledIcon, EyeFilledIcon } from '@heroui/shared-icons';
import { createUserWithEmailAndPassword, updateProfile } from 'firebase/auth';
import { FirebaseError } from 'firebase/app';
import { auth, db } from '@/firebase';
import { doc, setDoc } from 'firebase/firestore';
import type { User } from '@/app/types';
import AuthShell from '@/app/components/auth-shell';

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
      const trimmedEmail = email.trim();

      // Create user in Firebase Authentication
      const userCredential = await createUserWithEmailAndPassword(auth, trimmedEmail, password);
      const firebaseUser = userCredential.user;

      // Update user profile with full name
      await updateProfile(firebaseUser, {
        displayName: fullName,
      });

      // Store user data in Firestore
      const userData: User = {
        id: firebaseUser.uid,
        fullName,
        email: trimmedEmail,
        role: 'member',
        // Fresh accounts have not seen onboarding — the interactive tour fires
        // once on first use, then stamps this true (see onboarding-tour.tsx).
        tutorialCompleted: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await setDoc(doc(db, 'users', firebaseUser.uid), userData);

      // Already signed in via createUserWithEmailAndPassword — go straight to the dashboard.
      router.push('/dashboard');
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
    <AuthShell title="Create account" subtitle="Join BMRC Logistics today">
      {error && (
        <div className="w-full px-4 py-3 bg-danger-50 dark:bg-danger-950/20 border border-danger/30 rounded-large">
          <p className="text-danger text-sm font-medium">{error}</p>
        </div>
      )}
      <form onSubmit={handleSubmit} className="flex flex-col gap-5">
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
        <p className="text-foreground-500">
          Already have an account?{' '}
          <Link href="/login" className="text-primary font-semibold hover:underline">
            Sign In
          </Link>
        </p>
      </div>
    </AuthShell>
  );
}
