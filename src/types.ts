

export enum Screen {
  Login,
  Dashboard,
  Analysis,
  AuditTrail,
  Settings,
}

export type NavigateTo = (screen: Screen) => void;

export type Severity = 'critical' | 'warning';

export type FindingStatus = 'active' | 'resolved' | 'dismissed';

export interface Finding {
  id: string;
  title: string;
  severity: Severity;
  sourceSnippet: string;
  description?: string;
  regulation?: string;
  recommendation: string;
  status: FindingStatus;
}

export interface AnalysisReport {
  id: string;
  workspaceId: string;
  title: string;
  resilienceScore: number;
  scores?: {
    project: number;
    strategicGoals: number;
    regulations: number;
    risk: number;
  };
  findings: Finding[];
  summary: {
    critical: number;
    warning: number;
    checks: number;
  };
  documentContent: string;
  createdAt: string;
  status?: 'active' | 'archived';
  diffContent?: string;
}

// src/types.ts

export interface User {
  id: string;
  email: string;
  // ... any other properties

  // Add this optional token property
  token?: {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
}

export type UserRole = "Administrator" | "Risk Management Officer" | "Strategy Officer" | "Member";

export type FeedbackReason = "Not relevant to this project" | "This is a false positive" | "This is an accepted business risk";

export type AuditLogAction = 
  | 'User Login' 
  | 'User Logout' 
  | 'Social Login' 
  | 'Analysis Run' 
  | 'Document Upload' 
  | 'Auto-Fix' 
  | 'Finding Resolved' 
  | 'Finding Dismissed'
  | 'Workspace Created'
  | 'User Invited'
  | 'User Removed'
  | 'Role Changed'
  | 'Analysis Archived'
  | 'Analysis Unarchived'
  | 'Analysis Deleted'
  | 'Workspace Archived'
  | 'Workspace Unarchived'
  | 'Workspace Deleted'
  | 'Analysis Renamed'
  | 'Workspace Renamed'
  | 'Invitation Accepted'
  | 'Invitation Declined'
  | 'Invitation Revoked';

export interface AuditLog {
    id: string;
    timestamp: string;
    userEmail: string;
    action: AuditLogAction;
    details: string;
}

export enum KnowledgeCategory {
    Government = 'Government Regulations & Compliance',
    Risk = 'In-House Risk Management Plan',
    Strategy = 'Long-Term Strategic Direction'
}

export interface KnowledgeSource {
    id: string;
    workspaceId: string;
    title: string;
    content: string;
    category: KnowledgeCategory;
    isEditable: boolean;
}

export interface DismissalRule {
    id: string;
    workspaceId: string;
    findingTitle: string;
    reason: FeedbackReason;
    timestamp: string;
}

export interface CustomRegulation {
    id: string;
    workspaceId: string;
    ruleText: string;
    createdAt: string;
    createdBy: string;
}


export interface Workspace {
    id: string;
    name: string;
    creatorId: string;
    createdAt: string;
    status?: 'active' | 'archived';
}

export interface WorkspaceMember {
    email: string;
    role: UserRole;
    status: 'active' | 'pending';
}

export interface WorkspaceInvitation {
    workspaceId: string;
    workspaceName: string;
    inviterEmail: string;
    role: UserRole;
    timestamp: string;
}

export interface ScreenLayoutProps {
  navigateTo: NavigateTo;
  currentUser: User;
  onLogout: () => void;
  currentWorkspace: Workspace;
  onManageMembers: () => void;
  userRole: UserRole;
}

export interface TourStep {
  selector: string;
  title: string;
  content: string;
  position: 'top' | 'bottom' | 'left' | 'right';
}

export interface WorkspaceData {
    reports: AnalysisReport[];
    auditLogs: AuditLog[];
    knowledgeBaseSources: KnowledgeSource[];
    dismissalRules: DismissalRule[];
    customRegulations: CustomRegulation[];
}

export interface ChatMessage {
  role: 'user' | 'model';
  content: string;
}
export interface EnhancedAnalysisResponse {
  improvedDocumentContent: string;
  newAnalysis: Omit<AnalysisReport, 'id' | 'workspaceId' | 'createdAt' | 'documentContent'>;
}