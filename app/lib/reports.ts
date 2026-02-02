import {
  addDoc,
  collection,
  doc,
  updateDoc,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  arrayUnion,
  serverTimestamp,
  Timestamp,
  WriteBatch,
  DocumentData,
} from 'firebase/firestore';
import { db } from '@/firebase';
import { recordAuditEvent } from './audit';
import type { IssueReport } from '@/app/types';

/**
 * Create a new issue report and log an audit event.
 */
export async function createReport(params: {
  reporter: {
    userId: string | null;
    userName?: string | null;
    userEmail?: string | null;
    isAnonymous?: boolean;
  };
  type: 'bug' | 'feedback' | 'improvement' | 'question';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  title: string;
  description: string;
  reproductionSteps?: string[];
  pagePath?: string;
  component?: string;
  target?: { collection?: string; docId?: string };
}) {
  // Create the report document
  const reportData: Partial<IssueReport> = {
    reporter: params.reporter,
    type: params.type,
    priority: params.priority,
    status: 'open',
    title: params.title,
    description: params.description,
    reproductionSteps: params.reproductionSteps || [],
    pagePath: params.pagePath,
    component: params.component,
    target: params.target,
    comments: [],
    attachments: [],
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  const reportRef = await addDoc(collection(db, 'issue_reports'), reportData as DocumentData);

  // Log audit event
  await recordAuditEvent({
    eventType: 'issue_report_created',
    source: 'issue_reports',
    sourceId: reportRef.id,
    actor: {
      userId: params.reporter.userId,
      userName: params.reporter.userName,
      userEmail: params.reporter.userEmail,
    },
    targets: [
      {
        collection: 'issue_reports',
        docId: reportRef.id,
      },
    ],
    details: {
      type: params.type,
      priority: params.priority,
      title: params.title,
      isAnonymous: params.reporter.isAnonymous,
    },
  });

  return reportRef.id;
}

/**
 * Update an existing issue report.
 */
export async function updateReport(
  reportId: string,
  changes: Partial<IssueReport>
) {
  const reportRef = doc(db, 'issue_reports', reportId);
  const updateData = {
    ...changes,
    updatedAt: serverTimestamp(),
  };
  await updateDoc(reportRef, updateData as DocumentData);

  // Log audit event for triage actions
  if (changes.status || changes.assignedTo) {
    await recordAuditEvent({
      eventType: 'issue_report_updated',
      source: 'issue_reports',
      sourceId: reportId,
      targets: [
        {
          collection: 'issue_reports',
          docId: reportId,
        },
      ],
      details: {
        updatedFields: Object.keys(changes),
        status: changes.status,
        assignedTo: changes.assignedTo,
      },
    });
  }
}

/**
 * Add a comment to an issue report.
 */
export async function addComment(
  reportId: string,
  comment: {
    userId: string;
    userName?: string;
    message: string;
  }
) {
  const reportRef = doc(db, 'issue_reports', reportId);
  const newComment = {
    commentId: `${Date.now()}`,
    by: {
      userId: comment.userId,
      userName: comment.userName,
    },
    message: comment.message,
    timestamp: serverTimestamp(),
  };

  await updateDoc(reportRef, {
    comments: arrayUnion(newComment),
    updatedAt: serverTimestamp(),
  } as DocumentData);

  // Log audit event for comment
  await recordAuditEvent({
    eventType: 'issue_report_commented',
    source: 'issue_reports',
    sourceId: reportId,
    actor: {
      userId: comment.userId,
      userName: comment.userName,
    },
    details: {
      message: comment.message,
    },
  });
}

/**
 * Subscribe to open issue reports ordered by creation date (newest first).
 */
export function subscribeToOpenReports(
  callback: (reports: Array<IssueReport & { id: string }>) => void
) {
  const q = query(
    collection(db, 'issue_reports'),
    where('status', '==', 'open'),
    orderBy('createdAt', 'desc'),
    limit(100)
  );

  return onSnapshot(q, (snapshot) => {
    const reports = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    })) as Array<IssueReport & { id: string }>;
    callback(reports);
  });
}

/**
 * Subscribe to all issue reports (for admin triage view).
 */
export function subscribeToAllReports(
  callback: (reports: Array<IssueReport & { id: string }>) => void,
  options?: {
    status?: 'open' | 'triaged' | 'in_progress' | 'resolved' | 'closed' | 'all';
    assignedTo?: string;
  }
) {
  let q;

  if (options?.status && options.status !== 'all') {
    q = query(
      collection(db, 'issue_reports'),
      where('status', '==', options.status),
      orderBy('createdAt', 'desc'),
      limit(200)
    );
  } else {
    q = query(
      collection(db, 'issue_reports'),
      orderBy('createdAt', 'desc'),
      limit(200)
    );
  }

  return onSnapshot(q, (snapshot) => {
    let reports = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    })) as Array<IssueReport & { id: string }>;

    if (options?.assignedTo) {
      reports = reports.filter(
        (r) => r.assignedTo?.userId === options.assignedTo
      );
    }

    callback(reports);
  });
}

export default {
  createReport,
  updateReport,
  addComment,
  subscribeToOpenReports,
  subscribeToAllReports,
};
