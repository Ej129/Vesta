import mammoth from "mammoth"; 
import * as pdfjsLib from "pdfjs-dist"; 
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Screen, NavigateTo, AnalysisReport, User, AuditLog, AuditLogAction, KnowledgeSource, DismissalRule, FeedbackReason, Finding, KnowledgeCategory, Workspace, WorkspaceMember, UserRole, CustomRegulation, WorkspaceInvitation } from './types';
import { useAuth } from './contexts/AuthContext';
import LoginScreen from './screens/LoginScreen';
import UploadScreen from './screens/UploadScreen';
import AnalysisScreen from './screens/AnalysisScreen';
import AuditTrailScreen from './screens/AuditTrailScreen';
import SettingsScreen from './screens/SettingsScreen';
import CreateWorkspaceModal from './components/CreateWorkspaceModal';
import ManageMembersModal from './components/ManageMembersModal';
import KnowledgeBaseModal from './components/KnowledgeBaseModal';
import UploadModal from './components/UploadModal';
import * as workspaceApi from './api/workspace';
import { AlertTriangleIcon, BriefcaseIcon } from './components/Icons';
import { NotificationToast } from './components/NotificationToast';
import { Layout } from './components/Layout';
import { improvePlan, analyzePlan, improvePlanWithHighlights } from './api/vesta';
import { NewAnalysisModal } from './components/NewAnalysisModal';

// Quick analysis API
import { analyzePlanQuick } from './api/vesta';
import ConfirmationModal from './components/ConfirmationModal';

const ErrorScreen: React.FC<{ message: string }> = ({ message }) => (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gray-50 dark:bg-neutral-900 p-4 text-center">
        <div className="max-w-2xl bg-white dark:bg-neutral-900 p-8 rounded-lg shadow-lg border border-red-700">
            <AlertTriangleIcon className="w-16 h-16 mx-auto text-red-700" />
            <h1 className="text-2xl font-bold text-red-700 dark:text-red-600 mt-4">Application Configuration Error</h1>
            <p className="text-gray-500 dark:text-neutral-400 mt-2">
                The application cannot start because a required configuration is missing.
            </p>
            <div className="mt-4 p-4 bg-red-700/10 rounded-md text-left">
                <p className="font-mono text-sm text-red-700">{message}</p>
            </div>
            <p className="text-xs text-gray-500 dark:text-neutral-400 mt-6">
                <strong>Action Required:</strong> Please add the `API_KEY` environment variable in your Netlify site settings under "Site configuration" {'>'} "Build & deploy" {'>'} "Environment" and then trigger a new deploy.
            </p>
        </div>
    </div>
);


const InitializingScreen: React.FC = () => (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gray-50 dark:bg-neutral-900">
        <div className="animate-spin rounded-full h-16 w-16 border-b-4 border-red-700"></div>
        <p className="mt-4 text-lg font-semibold text-gray-500 dark:text-neutral-400">
            Initializing Session...
        </p>
    </div>
);

const NoWorkspaceSelectedScreen: React.FC<{ onCreate: () => void }> = ({ onCreate }) => (
    <div className="flex flex-col items-center justify-center h-full text-center p-8">
        <BriefcaseIcon className="w-16 h-16 text-gray-300 dark:text-neutral-600 mb-4" />
        <h2 className="text-xl font-bold text-gray-800 dark:text-neutral-200">No Workspace Selected</h2>
        <p className="text-gray-500 dark:text-neutral-400 mt-2 max-w-sm">
            Please select a workspace from the sidebar to view its content, or create a new one to get started.
        </p>
        <button
            onClick={onCreate}
            className="mt-6 bg-red-700 text-white font-bold py-2 px-5 rounded-lg transition-all duration-200 inline-flex items-center shadow-sm hover:shadow-md hover:bg-red-800"
        >
            Create Your First Workspace
        </button>
    </div>
);

const App: React.FC = () => {
  // --- FAIL-FAST CHECK ---
  if (!(import.meta as any).env.VITE_API_KEY) {
    return <ErrorScreen message="The 'VITE_API_KEY' environment variable is not set. This key is required to communicate with the Google Gemini API." />;
  }
  
  const { user: currentUser, loading, logout: handleLogout, getToken} = useAuth();

  const [screenStack, setScreenStack] = useState<Screen[]>([Screen.Dashboard]);
  
  const navigateTo = useCallback((screen: Screen) => {
    setScreenStack((s) => {
      if (s[s.length - 1] === screen) return s; // already there
      return [...s, screen];
    });
  }, []);

  const goBack = useCallback(() => {
    setScreenStack((s) => {
      if (s.length <= 1) return s;
      return s.slice(0, -1);
    });
  }, []);

  const currentScreen = screenStack[screenStack.length - 1];
  
  // Workspace state
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWorkspace, setSelectedWorkspace] = useState<Workspace | null>(null);
  const [workspaceMembers, setWorkspaceMembers] = useState<WorkspaceMember[]>([]);
  const [userRole, setUserRole] = useState<UserRole>('Member');
  const [invitations, setInvitations] = useState<WorkspaceInvitation[]>([]);
  
  // Data scoped to the selected workspace
  const [reports, setReports] = useState<AnalysisReport[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [knowledgeBaseSources, setKnowledgeBaseSources] = useState<KnowledgeSource[]>([]);
  const [dismissalRules, setDismissalRules] = useState<DismissalRule[]>([]);
  const [customRegulations, setCustomRegulations] = useState<CustomRegulation[]>([]);
  
  const [activeReport, setActiveReport] = useState<AnalysisReport | null>(null);
  
  // Modal State
  const [isCreateWorkspaceModalOpen, setCreateWorkspaceModalOpen] = useState(false);
  const [isManageMembersModalOpen, setManageMembersModalOpen] = useState(false);
  const [isKnowledgeBaseModalOpen, setKnowledgeBaseModalOpen] = useState(false);
  const [isUploadModalOpen, setUploadModalOpen] = useState(false);
  const [isNewAnalysisModalOpen, setIsNewAnalysisModalOpen] = useState(false); 
  const [confirmation, setConfirmation] = useState<{
    title: string;
    message: string;
    onConfirm: () => Promise<void>;
    confirmText?: string;
  } | null>(null);

  
  // Notification State
  const [notification, setNotification] = useState<{ message: string; workspaceName: string } | null>(null);
  const knownWorkspaceIds = useRef(new Set<string>());

  // Loading State
  const [isSyncingSources, setIsSyncingSources] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  // Enhancing state
  const [isEnhancing, setIsEnhancing] = useState(false);

  // Auto-enhance handler: improve the document then re-run analysis to update scores
  const handleAutoEnhance = useCallback(async (maybeReport?: AnalysisReport) => {
    const targetReport = (maybeReport && maybeReport.id)
      ? reports.find(r => r.id === maybeReport.id) ?? maybeReport
      : activeReport;
  
    if (!targetReport || !selectedWorkspace) {
      console.warn('Auto-enhance: no target report or workspace');
      return;
    }
  
    setIsEnhancing(true);
    try {
      // STEP 1: Securely get the enhanced text from the backend. (This part is working for you)
      const { text: improvedText, highlightedHtml } = await improvePlanWithHighlights(targetReport.documentContent, targetReport);
  
      // STEP 2 (THE FIX): Securely re-analyze the enhanced text using our backend function.
      // We will call the same endpoint as a new upload, but with the enhanced text.
      const token = await getToken();
      if (!token) {
          throw new Error("Authentication token not found for re-analysis.");
      }
  
      const reanalysisResponse = await fetch('/.netlify/functions/add-report', {
          method: 'POST',
          headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json',
          },
          body: JSON.stringify({
              textContent: improvedText,
              fileName: `${targetReport.title} (Enhanced)`,
              workspaceId: selectedWorkspace.id,
              analysisType: 'full', // or 'quick' depending on your preference
          }),
      });
  
      if (!reanalysisResponse.ok) {
          const errorBody = await reanalysisResponse.json();
          throw new Error(errorBody.error || 'Failed to re-analyze the enhanced document.');
      }
  
      const newReportData = await reanalysisResponse.json();
  
      // STEP 3: Merge the results into the existing report to preserve its ID.
      const updatedReport: AnalysisReport = {
        ...targetReport, // Keep original ID, createdAt, etc.
        documentContent: improvedText,
        title: newReportData.title,
        summary: newReportData.summary,
        findings: newReportData.findings,
        scores: newReportData.scores,
        resilienceScore: newReportData.resilienceScore,
        diffContent: highlightedHtml, // Add the highlighted diff
      };
  
      // 4. Update state and save the final, merged report
      await workspaceApi.updateReport(updatedReport); // Use updateReport to save over the old one
      setReports(prev => prev.map(r => (r.id === updatedReport.id ? updatedReport : r)));
      setActiveReport(updatedReport);
      await addAuditLog('Auto-Enhance', `Auto-enhanced and re-analyzed report: ${updatedReport.title}`, true);
  
    } catch (err) {
      console.error('Auto-enhance failed', err);
      alert((err as Error).message);
    } finally {
      setIsEnhancing(false);
    }
  }, [
    reports,
    activeReport,
    selectedWorkspace,
    getToken, // Add getToken to dependencies
    addAuditLog,
  ]);

  // Global Theme Persistence Fix
  useEffect(() => {
    const handleThemeChange = () => {
      if (localStorage.getItem('vesta-theme') === 'dark' || (!('vesta-theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
        document.documentElement.classList.add('dark');
      } else {
        document.documentElement.classList.remove('dark');
      }
    };
    
    window.addEventListener('storage', handleThemeChange);
    handleThemeChange();

    return () => {
      window.removeEventListener('storage', handleThemeChange);
    };
  }, []);



const loadWorkspaceData = useCallback(async (workspaceId: string, keepActiveReport = false) => {
  if (!currentUser) return;
  
  console.log("loadWorkspaceData called with keepActiveReport:", keepActiveReport);
  
  const data = await workspaceApi.getWorkspaceData(workspaceId);
  setReports(data.reports);
  setAuditLogs(data.auditLogs);
  setKnowledgeBaseSources(data.knowledgeBaseSources);
  setDismissalRules(data.dismissalRules);
  setCustomRegulations(data.customRegulations);
  
  const members = await workspaceApi.getWorkspaceMembers(workspaceId);
  setWorkspaceMembers(members);
  const member = members.find(m => m.email === currentUser.email);
  setUserRole(member?.role || 'Member');
  
  // Only reset activeReport if not explicitly keeping it
  if (!keepActiveReport) {
    console.log("Resetting activeReport to null");
    setActiveReport(null);
  } else {
    console.log("Keeping current activeReport");
  }
}, [currentUser]);

  const refreshWorkspaces = useCallback(async () => {
    if (!currentUser) return;
    const userWorkspaces = await workspaceApi.getWorkspacesForUser();
    setWorkspaces(userWorkspaces);
    knownWorkspaceIds.current = new Set(userWorkspaces.map(ws => ws.id));
    // If no workspace is selected, or the selected one is no longer available, select the first one.
    if ((!selectedWorkspace || !userWorkspaces.some(ws => ws.id === selectedWorkspace.id)) && userWorkspaces.length > 0) {
      handleSelectWorkspace(userWorkspaces[0]);
    } else if (userWorkspaces.length === 0) {
      setSelectedWorkspace(null);
    }
  }, [currentUser, selectedWorkspace]);

  const refreshInvitations = useCallback(async () => {
      if (!currentUser) return;
      const pendingInvitations = await workspaceApi.getPendingInvitations();
      setInvitations(pendingInvitations);
  }, [currentUser]);

  useEffect(() => {
    if (currentUser) {
      refreshWorkspaces();
      refreshInvitations();
    } else {
      // Clear all state when user logs out
      setWorkspaces([]);
      setSelectedWorkspace(null);
      setReports([]);
      setAuditLogs([]);
      setKnowledgeBaseSources([]);
      setDismissalRules([]);
      setCustomRegulations([]);
      setActiveReport(null);
      setInvitations([]);
      knownWorkspaceIds.current.clear();
    }
  }, [currentUser, refreshWorkspaces, refreshInvitations]);

  // Poll for new workspaces (from invitations being accepted)
  useEffect(() => {
      if (!currentUser) return;
      const intervalId = setInterval(async () => {
          const currentWorkspaces = await workspaceApi.getWorkspacesForUser();
          const newWorkspaces = currentWorkspaces.filter(ws => !knownWorkspaceIds.current.has(ws.id));
          if (newWorkspaces.length > 0) {
              const newWorkspace = newWorkspaces[0];
              await refreshWorkspaces();
              setNotification({
                  message: `You've been added to a new workspace!`,
                  workspaceName: newWorkspace.name,
              });
          }
          refreshInvitations();
      }, 30000);
      return () => clearInterval(intervalId);
  }, [currentUser, refreshWorkspaces, refreshInvitations]);
  
  
  // Move this above any code that calls addAuditLog
    async function addAuditLog(action: AuditLogAction | string, details: string, keepActiveReport = false) {
    if (!currentUser || !selectedWorkspace) return;
      try {
        // cast to AuditLogAction when calling the API to accept string literals in callers
        await workspaceApi.addAuditLog(selectedWorkspace.id, currentUser.email, action as AuditLogAction, details);
        // reload workspace data, optionally preserving active report
    await loadWorkspaceData(selectedWorkspace.id, keepActiveReport);
      } catch (err) {
        console.error('addAuditLog failed', err);
      }
    }

  const handleCreateWorkspace = async (name: string) => {
    if (!currentUser) return;
    try {
        const newWorkspace = await workspaceApi.createWorkspace(name);
        await refreshWorkspaces();
        setCreateWorkspaceModalOpen(false);
        await handleSelectWorkspace(newWorkspace);
    } catch (error) {
        console.error("Failed to create workspace:", error);
        throw error;
    }
  };

const handleSelectWorkspace = async (workspace: Workspace, reportToSelect?: AnalysisReport) => {
  if(selectedWorkspace?.id === workspace.id && currentScreen !== Screen.Analysis && !reportToSelect) return;
  
  setSelectedWorkspace(workspace);
  setActiveReport(reportToSelect || null); // Keep the report if provided
  await loadWorkspaceData(workspace.id);
  
  // Only navigate to dashboard if we're not selecting a specific report
  if (!reportToSelect) {
    navigateTo(Screen.Dashboard);
  }
};

  const handleAnalysisComplete = async (report: AnalysisReport) => {
    if (!selectedWorkspace) return;
    const newReport = { ...report, workspaceId: selectedWorkspace.id };
    const addedReport = await workspaceApi.addReport(newReport);
    await addAuditLog('Analysis Run', JSON.stringify({ message: `Analysis completed for: ${report.title}`, reportId: addedReport.id }));
    await loadWorkspaceData(selectedWorkspace.id);
    setActiveReport(addedReport);
    return addedReport;
  };

// Primary upload handler used by modal and wrappers
const handleFileUpload = async (content: string, fileName: string, quick?: boolean) => {
  if (!selectedWorkspace) return;

  try {
    // Add to audit log that file was uploaded
    addAuditLog('Document Upload', `File uploaded: ${fileName}`);

    // Start analyzing → keep modal open
    setIsAnalyzing(true);

    // Call API to analyze document
    const reportData = quick
      ? await analyzePlanQuick(
          content,
          knowledgeBaseSources,
          dismissalRules,
          customRegulations
        )
      : await analyzePlan(
      content,
      knowledgeBaseSources,
      dismissalRules,
      customRegulations
    );

    // Create new report object
    const report = {
      ...reportData,
      title: fileName || "Pasted Text Analysis",
    };

    // Save analysis result
    await handleAnalysisComplete(report as AnalysisReport);

    // Stop analyzing + close modal
    setIsAnalyzing(false);
    setUploadModalOpen(false);

    // Navigate to analysis screen
    navigateTo(Screen.Analysis);

  } catch (error) {
    console.error("Analysis failed:", error);
    setIsAnalyzing(false);
    alert("Analysis failed. Please try again.");
  }
};
const handleStartAnalysis = async (file: File, analysisType: 'quick' | 'full') => {
  if (!file || !selectedWorkspace || !currentUser) return;

  setIsAnalyzing(true);

  try {
    // 1. Extract text on the client-side first
    const textContent = await extractTextFromFile(file);

    if (!textContent) {
      throw new Error("Could not extract any text from the file. It might be empty or a scanned image.");
    }

    const token = await getToken();
    if (!token) {
      throw new Error("Authentication token not found. Please log in again.");
    }

    // 2. Send the extracted text and other data as a JSON payload
    const response = await fetch('/.netlify/functions/add-report', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json', // We are now sending JSON
      },
      body: JSON.stringify({
        textContent: textContent,
        fileName: file.name,
        workspaceId: selectedWorkspace.id,
        analysisType: analysisType,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.json(); // Server errors will now be JSON
      throw new Error(errorBody.error || 'Failed to start analysis.');
    }

    const newReport = await response.json();

    setReports(prevReports => [newReport, ...prevReports]);
    setActiveReport(newReport);
    navigateTo(Screen.Analysis);

  } catch (error) {
    console.error("Error starting analysis:", error);
    alert((error as Error).message);
  } finally {
    setIsAnalyzing(false);
    setIsNewAnalysisModalOpen(false);
  }
};
// Set up the worker for pdf.js
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url,
).toString();

const extractTextFromFile = async (file: File): Promise<string> => {
  const ext = file.name.split('.').pop()?.toLowerCase() || '';
  if (ext === 'pdf') {
    const arrayBuffer = await file.arrayBuffer();
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    const pdf = await loadingTask.promise;
    let text = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      const pageText = textContent.items.map((item: any) => item.str).join(' ');
      text += pageText + '\n';
    }
    return text.trim();
  } else if (ext === 'docx') {
    const arrayBuffer = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer });
    return result.value?.trim() || '';
  } else if (['txt', 'md'].includes(ext)) {
    return await file.text();
  } else {
    throw new Error('Unsupported file type. Please upload a .pdf, .docx, or .txt file.');
  }
};
  
const handleSelectReport = (report: AnalysisReport) => {
  if (!report) return;
  
  // First, check if this report belongs to a different workspace
  if (selectedWorkspace?.id !== report.workspaceId) {
    // Find the workspace this report belongs to
    const reportWorkspace = workspaces.find(ws => ws.id === report.workspaceId);
    if (reportWorkspace) {
      // Switch to the correct workspace first
      handleSelectWorkspace(reportWorkspace).then(() => {
        // After workspace is loaded, set the active report
        setActiveReport(report);
        navigateTo(Screen.Analysis);
      });
      return;
    }
  }
  
  // If already in the correct workspace, just set the report and navigate
  setActiveReport(report);
  navigateTo(Screen.Analysis);
};


  const handleUpdateReport = async (updatedReport: AnalysisReport) => {
      try {
          const savedReport = await workspaceApi.updateReport(updatedReport);
          setReports(prevReports => prevReports.map(r => r.id === savedReport.id ? savedReport : r));
          setActiveReport(savedReport);
      } catch (error) {
          console.error("Failed to update report:", error);
          alert((error as Error).message);
      }
  };



  const addKnowledgeSource = async (title: string, content: string, category: KnowledgeCategory) => {
    if (!selectedWorkspace) return;
    await workspaceApi.addKnowledgeSource(selectedWorkspace.id, { title, content, category, isEditable: true });
    await loadWorkspaceData(selectedWorkspace.id);
  };

  const deleteKnowledgeSource = async (id: string) => {
    if (!selectedWorkspace) return;
    await workspaceApi.deleteKnowledgeSource(selectedWorkspace.id, id);
    await loadWorkspaceData(selectedWorkspace.id);
  };
  
  const addDismissalRule = async (finding: Finding, reason: FeedbackReason) => {
    if (!selectedWorkspace) return;
    await workspaceApi.addDismissalRule(selectedWorkspace.id, { findingTitle: finding.title, reason });
    await loadWorkspaceData(selectedWorkspace.id);
  };

  const deleteDismissalRule = async (id: string) => {
    if (!selectedWorkspace) return;
    await workspaceApi.deleteDismissalRule(selectedWorkspace.id, id);
    await loadWorkspaceData(selectedWorkspace.id);
  };

  const handleAddRegulation = async (ruleText: string) => {
      if (!selectedWorkspace || !currentUser) return;
      await workspaceApi.addCustomRegulation(selectedWorkspace.id, ruleText, currentUser.email);
      await loadWorkspaceData(selectedWorkspace.id);
  };

  const handleDeleteRegulation = async (regulationId: string) => {
      if (!selectedWorkspace) return;
      await workspaceApi.deleteCustomRegulation(selectedWorkspace.id, regulationId);
      await loadWorkspaceData(selectedWorkspace.id);
  };

  const handleUserUpdate = async (updatedUser: User) => {
    try {
        await workspaceApi.updateUser(updatedUser);
        alert("Profile updated. Note: some changes from Netlify may override this on your next session.");
    } catch(err) {
        console.error("Failed to update user:", err);
    }
  };
  
  const handleInviteUser = async (email: string, role: UserRole) => {
      if (!selectedWorkspace) return;
      try {
          await workspaceApi.inviteUser(selectedWorkspace.id, email, role);
          await addAuditLog('User Invited', `Invited ${email} as ${role}.`);
          await loadWorkspaceData(selectedWorkspace.id); // Refresh member list
      } catch (error) {
          alert((error as Error).message);
      }
  };

  const handleRemoveUser = async (email: string, status: 'active' | 'pending') => {
      if (!selectedWorkspace) return;
      await workspaceApi.removeUser(selectedWorkspace.id, email);
      const action = status === 'active' ? 'User Removed' : 'Invitation Revoked';
      const details = status === 'active' ? `Removed user ${email}.` : `Revoked invitation for ${email}.`;
      await addAuditLog(action, details);
      await loadWorkspaceData(selectedWorkspace.id);
  };

  const handleUpdateRole = async (email: string, role: UserRole) => {
      if (!selectedWorkspace) return;
      await workspaceApi.updateUserRole(selectedWorkspace.id, email, role);
      await addAuditLog('Role Changed', `Changed role for ${email} to ${role}.`);
      await loadWorkspaceData(selectedWorkspace.id);
  };

  const handleUpdateWorkspaceName = async (workspaceId: string, name: string) => {
    try {
        await workspaceApi.updateWorkspaceName(workspaceId, name);
        setSelectedWorkspace(prev => prev ? { ...prev, name } : null);
        setWorkspaces(prev => prev.map(ws => ws.id === workspaceId ? { ...ws, name } : ws));
        await loadWorkspaceData(workspaceId);
    } catch (error) {
        console.error("Failed to update workspace name:", error);
        alert((error as Error).message);
        refreshWorkspaces();
    }
  };
  
  const handleRespondToInvitation = async (workspaceId: string, response: 'accept' | 'decline') => {
    try {
        await workspaceApi.respondToInvitation(workspaceId, response);
        await refreshInvitations();
        if (response === 'accept') {
            await refreshWorkspaces();
        }
    } catch (error) {
        alert((error as Error).message);
    }
  };

  const handleUpdateWorkspaceStatus = async (workspaceId: string, status: 'active' | 'archived') => {
    try {
        await workspaceApi.updateWorkspaceStatus(workspaceId, status);
        // The serverless function now handles audit logging, so we just refresh.
        await refreshWorkspaces();
        // If the currently selected workspace was archived, navigate away
        if (selectedWorkspace?.id === workspaceId && status === 'archived') {
            const firstActive = workspaces.find(ws => ws.status !== 'archived' && ws.id !== workspaceId);
            if (firstActive) {
                handleSelectWorkspace(firstActive);
            } else {
                setSelectedWorkspace(null);
            }
        }
    } catch (error) {
        console.error(`Failed to ${status === 'active' ? 'unarchive' : 'archive'} workspace:`, error);
        alert((error as Error).message);
    }
  };

  const handleDeleteWorkspace = (workspace: Workspace) => {
    setConfirmation({
        title: "Delete Workspace",
        message: `Are you sure you want to permanently delete the "${workspace.name}" workspace? This will also delete all associated analyses and data. This action cannot be undone.`,
        confirmText: "Delete Workspace",
        onConfirm: async () => {
            try {
                if (currentUser) {
                     // The delete function will remove all data, so log first. The function itself cannot log to a store that's about to be deleted.
                    await workspaceApi.addAuditLog(workspace.id, currentUser.email, 'Workspace Deleted', `Workspace "${workspace.name}" was permanently deleted.`);
                }
                await workspaceApi.deleteWorkspace(workspace.id);
                await refreshWorkspaces();
            } catch (error) {
                console.error("Failed to delete workspace:", error);
                alert((error as Error).message);
            }
        }
    });
  };

  const handleUpdateReportStatus = async (reportId: string, status: 'active' | 'archived') => {
    if (!selectedWorkspace) return;
    try {
        await workspaceApi.updateReportStatus(reportId, status);
        const action = status === 'archived' ? 'Analysis Archived' : 'Analysis Unarchived';
        const report = reports.find(r => r.id === reportId);
        await addAuditLog(action, `Analysis "${report?.title || reportId}" status changed to ${status}.`);
        await loadWorkspaceData(selectedWorkspace.id);
    } catch (error) {
        console.error(`Failed to ${status === 'active' ? 'unarchive' : 'archive'} report:`, error);
        alert((error as Error).message);
    }
  };

  // safe, optimistic bulk delete handler
  async function handleDeleteReportOptimized(inputIds: string | string[]) {
    const ids = Array.isArray(inputIds) ? inputIds.filter(Boolean) : [inputIds].filter(Boolean);
    if (ids.length === 0 || !selectedWorkspace) return;

    // Confirm once
    if (!confirm(`Delete ${ids.length} analysis${ids.length > 1 ? 'es' : ''}? This cannot be undone.`)) return;

    // keep snapshot to allow restore
    const prevReports = [...reports];
    const prevActive = activeReport;

    // optimistic UI update: remove immediately, but pick a fallback activeReport instead of null
    const remaining = prevReports.filter(r => !ids.includes(r.id));
    setReports(remaining);
    if (activeReport && ids.includes(activeReport.id)) {
      // choose first remaining as active, or null if none
      setActiveReport(remaining[0] ?? null);
    }

    try {
      // use bulk API
      const res = await workspaceApi.deleteReportsBulk(ids, 8);
      if (res.failed.length > 0) {
        // restore failed items back into UI
        const failedIds = new Set(res.failed.map(f => f.id));
        const restored = prevReports.filter(r => failedIds.has(r.id));
        // restore in original order
        const next = [...restored, ...remaining];
        setReports(next);
        // if previous active was removed and not deleted, restore it
        if (prevActive && failedIds.has(prevActive.id)) setActiveReport(prevActive);
        console.error('Some deletes failed', res.failed);
        alert(`Failed to delete ${res.failed.length} item(s). They were restored.`);
      } else {
        // success: optional audit log
        try { await addAuditLog?.('Delete', `Deleted ${res.success.length} analyses`, false); } catch (e) { /* ignore */ }
      }
    } catch (err) {
      // fallback: attempt sequential single deletes
      try {
        const failed: string[] = [];
        for (const id of ids) {
          try { await workspaceApi.deleteReport(id); } catch (e) { failed.push(id); }
        }
        if (failed.length) {
          const failedSet = new Set(failed);
          const restored = prevReports.filter(r => failedSet.has(r.id));
          const next = [...restored, ...remaining];
          setReports(next);
          if (prevActive && failedSet.has(prevActive.id)) setActiveReport(prevActive);
          alert(`Failed to delete ${failed.length} item(s). They were restored.`);
        } else {
          try { await addAuditLog?.('Delete', `Deleted ${ids.length} analyses (sequential)`, false); } catch (_) {}
        }
      } catch (e2) {
        // restore full previous state
        setReports(prevReports);
        setActiveReport(prevActive);
        console.error('Delete error', e2);
        alert('Failed to delete reports. Please try again.');
      }
    }
  }

  // Backwards-compatible wrapper: the UI expects `handleDeleteReport` — forward to optimized implementation.
  const handleDeleteReport = async (reportIds: string[] | string) => {
    return handleDeleteReportOptimized(reportIds);
  };

const renderScreenComponent = () => {
  // Allow Analysis to render if we already have an activeReport,
  // even if selectedWorkspace is momentarily null.
  if (currentScreen === Screen.Analysis && activeReport) {
    const layoutProps = {
      navigateTo,
      currentUser: currentUser!,
      onLogout: handleLogout,
      currentWorkspace: selectedWorkspace, // can be null briefly
      onManageMembers: () => setManageMembersModalOpen(true),
      userRole,
    };

    return (
      <AnalysisScreen
        key={activeReport.id}                 // force fresh mount per report
        {...layoutProps}
        activeReport={activeReport}
        onUpdateReport={handleUpdateReport}
        onAutoEnhance={handleAutoEnhance}
        isEnhancing={isEnhancing}
        analysisStatusText={isEnhancing ? "Enhancing…" : (isAnalyzing ? "Analyzing…" : "")}
      />
    );
  }

  // For all other screens, still require a workspace.
  if (!selectedWorkspace) {
    return <NoWorkspaceSelectedScreen onCreate={() => setCreateWorkspaceModalOpen(true)} />;
  }

  const layoutProps = {
    navigateTo,
    currentUser: currentUser!,
    onLogout: handleLogout,
    currentWorkspace: selectedWorkspace,
    onManageMembers: () => setManageMembersModalOpen(true),
    userRole,
  };

  switch (currentScreen) {
case Screen.Dashboard:
  return (
    <UploadScreen
      reports={reports}
      onSelectReport={handleSelectReport}
      onNewAnalysisClick={() => setIsNewAnalysisModalOpen(true)} // <-- THIS IS THE NEW LINE
      onUpdateReportStatus={handleUpdateReportStatus}
      onDeleteReport={(report: AnalysisReport) => handleDeleteReport(report.id)}
    />
  );
    case Screen.Analysis: // fallback if no activeReport yet
      return (
        <div className="flex items-center justify-center h-full p-8 text-gray-500">
          Loading analysis…
        </div>
      );
    case Screen.AuditTrail:
      return <AuditTrailScreen {...layoutProps} logs={auditLogs} reports={reports} onSelectReport={handleSelectReport} />;
    case Screen.Settings:
      return <SettingsScreen {...layoutProps} dismissalRules={dismissalRules} onDeleteDismissalRule={deleteDismissalRule} onUserUpdate={handleUserUpdate} customRegulations={customRegulations} onAddRegulation={handleAddRegulation} onDeleteRegulation={handleDeleteRegulation} />;
    default:
      return (
        <UploadScreen
          reports={reports}
          onSelectReport={handleSelectReport}
          onNewAnalysisClick={() => setUploadModalOpen(true)}
          onUpdateReportStatus={handleUpdateReportStatus}
          onDeleteReport={(report: AnalysisReport) => handleDeleteReport(report.id)}
        />
      );
  }
};


  if (loading) return <InitializingScreen />;
  if (!currentUser) return <LoginScreen />;

  return (
    <div className="font-sans bg-gray-50 dark:bg-neutral-950 min-h-screen text-gray-800 dark:text-neutral-200">
        {confirmation && (
            <ConfirmationModal
                title={confirmation.title}
                message={confirmation.message}
                confirmText={confirmation.confirmText}
                onConfirm={confirmation.onConfirm}
                onCancel={() => setConfirmation(null)}
            />
        )}
        {notification && (
            <NotificationToast 
                message={notification.message}
                workspaceName={notification.workspaceName}
                onClose={() => setNotification(null)}
            />
        )}
        {isCreateWorkspaceModalOpen && (
            <CreateWorkspaceModal 
                onClose={() => setCreateWorkspaceModalOpen(false)}
                onCreate={handleCreateWorkspace}
            />
        )}
        {selectedWorkspace && isManageMembersModalOpen && (
            <ManageMembersModal 
                onClose={() => setManageMembersModalOpen(false)}
                currentMembers={workspaceMembers}
                currentUserEmail={currentUser.email}
                onInviteUser={handleInviteUser}
                onRemoveUser={handleRemoveUser}
                onUpdateRole={handleUpdateRole}
            />
        )}
        {isKnowledgeBaseModalOpen && selectedWorkspace && (
             <KnowledgeBaseModal
                onClose={() => setKnowledgeBaseModalOpen(false)}
                sources={knowledgeBaseSources}
                onAddSource={addKnowledgeSource}
                onDeleteSource={deleteKnowledgeSource}
                isSyncing={isSyncingSources}
                userRole={userRole}
            />
        )}
        {isUploadModalOpen && (
            <UploadModal
                onClose={() => setUploadModalOpen(false)}
                onUpload={handleFileUpload}
                isAnalyzing={isAnalyzing}
            />
        )}
                {/* ADD THE CODE BLOCK BELOW */}
                {isNewAnalysisModalOpen && (
            <NewAnalysisModal
                isOpen={isNewAnalysisModalOpen}
                onClose={() => setIsNewAnalysisModalOpen(false)}
                onAnalyze={handleStartAnalysis}
                isAnalyzing={isAnalyzing}
            />
        )}
        <Layout
            navigateTo={navigateTo}
            currentUser={currentUser}
            onLogout={handleLogout}
            currentWorkspace={selectedWorkspace}
            currentScreen={currentScreen}
            workspaces={workspaces}
            onSelectWorkspace={handleSelectWorkspace}
            onManageMembers={() => setManageMembersModalOpen(true)}
            userRole={userRole}
            onCreateWorkspace={() => setCreateWorkspaceModalOpen(true)}
            onUpdateWorkspaceName={handleUpdateWorkspaceName}
            onKnowledgeBase={() => setKnowledgeBaseModalOpen(true)}
            onNewAnalysis={() => setUploadModalOpen(true)}
            onUpdateWorkspaceStatus={handleUpdateWorkspaceStatus}
            onDeleteWorkspace={handleDeleteWorkspace}
            invitations={invitations}
            onRespondToInvitation={handleRespondToInvitation}
        >
            {renderScreenComponent()}
        </Layout>
    </div>
  );
}

// Lightweight module-scoped storage for enhanced drafts.
// This mirrors the minimal API of a React state setter so existing calls like
// `setEnhancedDrafts(prev => ({ ...prev, [id]: draft }))` work.
// Drafts are persisted to localStorage so they survive reloads.
type EnhancedDrafts = Record<string, { text: string; highlightedHtml?: string }>;

const STORAGE_KEY = 'vesta-enhanced-drafts';

// init from localStorage
let _enhancedDrafts: EnhancedDrafts = {};
try {
  const raw = localStorage.getItem(STORAGE_KEY);
  _enhancedDrafts = raw ? JSON.parse(raw) : {};
} catch (e) {
  console.warn('Failed to parse enhanced drafts from localStorage', e);
  _enhancedDrafts = {};
}

/**
 * setEnhancedDrafts accepts either a new value or an updater function like React's setState.
 * It updates the in-memory store and persists to localStorage.
 */
function setEnhancedDrafts(updater: EnhancedDrafts | ((prev: EnhancedDrafts) => EnhancedDrafts)) {
  try {
    const next =
      typeof updater === 'function'
        ? (updater as (prev: EnhancedDrafts) => EnhancedDrafts)(_enhancedDrafts)
        : updater;

    _enhancedDrafts = next || {};
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(_enhancedDrafts));
    } catch (e) {
      // ignore storage errors (e.g., quota), but keep in-memory copy
      console.warn('Failed to persist enhanced drafts to localStorage', e);
    }
  } catch (err) {
    console.error('setEnhancedDrafts error', err);
  }
}

// Optional getter if you need to read drafts from outside the component
export function getEnhancedDrafts(): EnhancedDrafts {
  return _enhancedDrafts;
}

export default App;
