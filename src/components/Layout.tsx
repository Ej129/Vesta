// src/components/Layout.tsx

import React, { useState, useRef, useEffect } from 'react';
import { NavigateTo, Screen, User, UserRole, Workspace, WorkspaceInvitation } from '../types';
import { VestaLogo, SearchIcon, PlusIcon, ChevronsLeftIcon, LibraryIcon, SettingsIcon, HistoryIcon, LogoutIcon, BriefcaseIcon, EditIcon, MoreVerticalIcon, UsersIcon, BellIcon } from './Icons';
import InvitationDropdown from './InvitationDropdown';


interface LayoutProps {
  children: React.ReactNode;
  navigateTo: NavigateTo;
  currentUser: User;
  onLogout: () => void;
  currentWorkspace: Workspace | null;
  workspaces: Workspace[];
  onSelectWorkspace: (workspace: Workspace) => void;
  userRole: UserRole;
  onManageMembers: () => void;
  onCreateWorkspace: () => void;
  onUpdateWorkspaceName: (workspaceId: string, newName: string) => void;
  onKnowledgeBase: () => void;
  onNewAnalysis: () => void;
  onUpdateWorkspaceStatus: (workspaceId: string, status: 'active' | 'archived') => void;
  onDeleteWorkspace: (workspace: Workspace) => void;
  invitations: WorkspaceInvitation[];
  onRespondToInvitation: (workspaceId: string, response: 'accept' | 'decline') => void;
}

const UserProfileDropdown: React.FC<{ navigateTo: NavigateTo; onLogout: () => void; onManageMembers: () => void }> = ({ navigateTo, onLogout, onManageMembers }) => (
    <div className="absolute bottom-full mb-2 w-56 bg-white dark:bg-neutral-900 rounded-md shadow-lg z-20 border border-gray-200 dark:border-neutral-700 py-1">
        <button onClick={() => navigateTo(Screen.Settings)} className="w-full text-left flex items-center px-4 py-2 text-sm text-gray-800 dark:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-800 transition-colors duration-200">
            <SettingsIcon className="w-4 h-4 mr-3" /> Profile Settings
        </button>
        <button onClick={onManageMembers} className="w-full text-left flex items-center px-4 py-2 text-sm text-gray-800 dark:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-800 transition-colors duration-200">
            <UsersIcon className="w-4 h-4 mr-3" /> Manage Members
        </button>
        <button onClick={() => navigateTo(Screen.AuditTrail)} className="w-full text-left flex items-center px-4 py-2 text-sm text-gray-800 dark:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-800 transition-colors duration-200">
            <HistoryIcon className="w-4 h-4 mr-3" /> Audit Trail
        </button>
        <div className="my-1 h-px bg-gray-200 dark:bg-neutral-700" />
        <button onClick={onLogout} className="w-full text-left flex items-center px-4 py-2 text-sm text-red-700 hover:bg-gray-100 dark:hover:bg-neutral-800 transition-colors duration-200">
            <LogoutIcon className="w-4 h-4 mr-3" /> Logout
        </button>
    </div>
);

const WorkspaceSidebar: React.FC<Pick<LayoutProps, 'currentUser' | 'onLogout' | 'workspaces' | 'currentWorkspace' | 'onSelectWorkspace' | 'onCreateWorkspace' | 'navigateTo' | 'onManageMembers' | 'onNewAnalysis' | 'onKnowledgeBase' | 'onUpdateWorkspaceStatus' | 'onDeleteWorkspace' | 'onUpdateWorkspaceName' | 'invitations' | 'onRespondToInvitation' > & { isCollapsed: boolean, onToggleCollapse: () => void }> =
  ({ currentUser, onLogout, workspaces, currentWorkspace, onSelectWorkspace, onCreateWorkspace, navigateTo, onManageMembers, isCollapsed, onToggleCollapse, onKnowledgeBase, onNewAnalysis, onUpdateWorkspaceStatus, onDeleteWorkspace, onUpdateWorkspaceName, invitations, onRespondToInvitation }) => {
    const [searchTerm, setSearchTerm] = useState('');
    const [isProfileOpen, setProfileOpen] = useState(false);
    const [showArchived, setShowArchived] = useState(false);
    const [activeMenu, setActiveMenu] = useState<string | null>(null);
    const [editingWorkspace, setEditingWorkspace] = useState<Workspace | null>(null);
    const [newName, setNewName] = useState("");
    const profileRef = useRef<HTMLDivElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const [isInvitationsOpen, setInvitationsOpen] = useState(false);
    const invitationRef = useRef<HTMLDivElement>(null);
    const searchInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (profileRef.current && !profileRef.current.contains(event.target as Node)) setProfileOpen(false);
            if (menuRef.current && !menuRef.current.contains(event.target as Node)) setActiveMenu(null);
            if (invitationRef.current && !invitationRef.current.contains(event.target as Node)) setInvitationsOpen(false);
        };
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, [profileRef, menuRef, invitationRef]);

     useEffect(() => {
        if (editingWorkspace && inputRef.current) {
            inputRef.current.focus();
        }
    }, [editingWorkspace]);
    
    const activeWorkspaces = workspaces.filter(ws => ws.status !== 'archived');
    const archivedWorkspaces = workspaces.filter(ws => ws.status === 'archived');

    const filteredWorkspaces = [
        ...activeWorkspaces.filter(ws => ws.name.toLowerCase().includes(searchTerm.toLowerCase())),
        ...(showArchived ? archivedWorkspaces.filter(ws => ws.name.toLowerCase().includes(searchTerm.toLowerCase())) : [])
    ];

    const getInitials = (name: string) => name.split(' ').map(n => n[0]).join('').toUpperCase();
    
    const handleRename = (ws: Workspace) => {
        setEditingWorkspace(ws);
        setNewName(ws.name);
        setActiveMenu(null);
    };

    const handleRenameSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (editingWorkspace && newName.trim()) {
            onUpdateWorkspaceName(editingWorkspace.id, newName.trim());
        }
        setEditingWorkspace(null);
    };
    
    const handleSearchClick = () => {
        if (isCollapsed) {
            onToggleCollapse();
            setTimeout(() => {
                searchInputRef.current?.focus();
            }, 300);
        }
    };
    
    const highlightMatch = (name: string) => {
        if (!searchTerm) return name;
        const parts = name.split(new RegExp(`(${searchTerm})`, 'gi'));
        return (
            <>
                {parts.map((part, index) =>
                    part.toLowerCase() === searchTerm.toLowerCase() ? (
                        <span key={index} className="text-red-700 font-bold">{part}</span>
                    ) : (
                        part
                    )
                )}
            </>
        );
    };

    return (
        <aside className={`bg-white dark:bg-neutral-900 border-r border-gray-200 dark:border-neutral-800 shadow-lg dark:shadow-black/20 flex flex-col h-full transition-all duration-300 ease-in-out ${isCollapsed ? 'w-20' : 'w-80'}`}>
            <div className={`relative p-4 flex-shrink-0 border-b border-gray-200 dark:border-neutral-700 flex ${isCollapsed ? 'flex-col items-center space-y-4' : 'items-center justify-between'}`}>
                <div className={`flex items-center flex-shrink-0 ${isCollapsed ? 'w-full justify-center' : ''}`}>
                    {isCollapsed ? (
                        <VestaLogo className="w-9 h-9" />
                    ) : (
                        <>
                          <VestaLogo className="w-9 h-9 flex-shrink-0" />
                          <span className={`ml-3 font-bold text-xl tracking-tight text-gray-800 dark:text-neutral-50 whitespace-nowrap transition-all duration-300 ${isCollapsed ? 'opacity-0' : 'opacity-100'}`}>
                              VESTA
                          </span>
                        </>
                    )}
                </div>
                
                <div className={`flex items-center ${isCollapsed ? 'flex-col-reverse space-y-2 space-y-reverse mt-auto' : 'space-x-1'}`}>
                    <button onClick={onToggleCollapse} title={isCollapsed ? "Expand Sidebar" : "Collapse Sidebar"} className="p-2 rounded-md text-gray-500 dark:text-neutral-400 hover:bg-gray-100 dark:hover:bg-neutral-800 transition-colors duration-200">
                        <ChevronsLeftIcon className={`w-5 h-5 transition-transform ${isCollapsed ? 'rotate-180' : ''}`} />
                    </button>
                    <div ref={invitationRef}>
                        <button 
                            onClick={() => setInvitationsOpen(o => !o)} 
                            className="p-2 rounded-md text-gray-500 dark:text-neutral-400 hover:bg-gray-100 dark:hover:bg-neutral-800 relative"
                            aria-label="View invitations"
                        >
                            <BellIcon className="w-6 h-6" />
                            {invitations.length > 0 && (
                                <span className="absolute top-1 right-1 w-2.5 h-2.5 bg-red-600 rounded-full border-2 border-white dark:border-neutral-900"></span>
                            )}
                        </button>
                        {isInvitationsOpen && (
                            <InvitationDropdown 
                                invitations={invitations} 
                                onRespond={onRespondToInvitation} 
                                onClose={() => setInvitationsOpen(false)} 
                                isCollapsed={isCollapsed}
                            />
                        )}
                    </div>
                    <button onClick={onNewAnalysis} title="New Analysis" className="p-2 rounded-md text-gray-500 dark:text-neutral-400 hover:bg-gray-100 dark:hover:bg-neutral-800 transition-colors duration-200">
                        <EditIcon className="w-6 h-6" />
                    </button>
                    <button onClick={onKnowledgeBase} title="Knowledge Base" className="p-2 rounded-md text-gray-500 dark:text-neutral-400 hover:bg-gray-100 dark:hover:bg-neutral-800 transition-colors duration-200">
                        <LibraryIcon className="w-6 h-6" />
                    </button>
                </div>
            </div>

            <div className={`p-4 flex-shrink-0`}>
                 <div className={`relative`}>
                     <SearchIcon className={`absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400 dark:text-neutral-500 transition-all duration-300`} />
                     <input
                         ref={searchInputRef}
                         onClick={handleSearchClick}
                         readOnly={isCollapsed}
                         type="text"
                         placeholder={isCollapsed ? '' : "Search..."}
                         value={searchTerm}
                         onChange={e => setSearchTerm(e.target.value)}
                         className={`w-full bg-gray-100 dark:bg-neutral-800 border border-transparent rounded-lg py-2 focus:outline-none focus:ring-2 focus:ring-red-700 text-gray-800 dark:text-neutral-200 placeholder:text-gray-400 dark:placeholder:text-neutral-500 transition-all duration-300 ${isCollapsed ? 'pl-10 cursor-pointer' : 'pl-10 pr-4'}`}
                     />
                 </div>
            </div>

            <nav className="flex-1 px-4 pt-2 overflow-y-auto">
                <p className={`text-sm font-semibold tracking-wider text-gray-500 dark:text-neutral-500 mb-2 px-3 transition-opacity duration-200 ${isCollapsed ? 'opacity-0 h-0 pointer-events-none' : 'opacity-100'}`}>Workspaces</p>
                <ul className="space-y-1">
                    {filteredWorkspaces.map(ws => (
                        <li key={ws.id} className="group relative">
                            {editingWorkspace?.id === ws.id ? (
                                <form onSubmit={handleRenameSubmit}>
                                    <input
                                        ref={inputRef}
                                        type="text"
                                        value={newName}
                                        onChange={e => setNewName(e.target.value)}
                                        onBlur={handleRenameSubmit}
                                        className="w-full text-left px-3 py-2.5 rounded-lg text-sm bg-white dark:bg-black ring-2 ring-red-700 outline-none"
                                    />
                                </form>
                            ) : (
                                <>
                                <button
                                    title={ws.name}
                                    onClick={() => onSelectWorkspace(ws)}
                                    // UPDATED: Active workspace style
                                    className={`w-full text-left pl-3 pr-10 py-2.5 rounded-lg text-sm transition-colors duration-200 flex items-center relative ${currentWorkspace?.id === ws.id ? 'bg-neutral-200 dark:bg-neutral-800' : 'hover:bg-gray-100 dark:hover:bg-neutral-800/50 text-gray-600 dark:text-neutral-400'} ${ws.status === 'archived' ? 'opacity-60' : ''}`}
                                >
                                    {currentWorkspace?.id === ws.id && <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-red-700 rounded-r-full"></div>}
                                    <BriefcaseIcon className={`w-5 h-5 flex-shrink-0 ${currentWorkspace?.id === ws.id ? 'text-red-700 dark:text-red-500' : 'text-gray-500 dark:text-neutral-500'}`} />
                                    <span className={`ml-3 truncate transition-opacity duration-200 ${isCollapsed ? 'opacity-0' : 'opacity-100'} ${currentWorkspace?.id === ws.id ? 'font-semibold text-gray-900 dark:text-neutral-50' : ''}`}>{highlightMatch(ws.name)}</span>
                                </button>
                                {!isCollapsed && (
                                    <div className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity">
                                        <button onClick={() => setActiveMenu(ws.id)} className="p-1 rounded-md hover:bg-gray-200 dark:hover:bg-neutral-700">
                                            <MoreVerticalIcon className="w-4 h-4 text-gray-500 dark:text-neutral-400"/>
                                        </button>
                                    </div>
                                )}
                                </>
                            )}
                            {activeMenu === ws.id && !isCollapsed && (
                                <div ref={menuRef} className="absolute z-10 right-0 top-10 w-48 bg-white dark:bg-neutral-900 rounded-md shadow-lg border border-gray-200 dark:border-neutral-700 py-1">
                                    <button onClick={() => handleRename(ws)} className="block w-full text-left px-3 py-1.5 text-sm hover:bg-gray-100 dark:hover:bg-neutral-800">Rename</button>
                                    <div className="my-1 h-px bg-gray-200 dark:bg-neutral-700" />
                                    {ws.status === 'archived' ? (
                                        <button onClick={() => { onUpdateWorkspaceStatus(ws.id, 'active'); setActiveMenu(null); }} className="block w-full text-left px-3 py-1.5 text-sm hover:bg-gray-100 dark:hover:bg-neutral-800">Unarchive</button>
                                    ) : (
                                        <button onClick={() => { onUpdateWorkspaceStatus(ws.id, 'archived'); setActiveMenu(null); }} className="block w-full text-left px-3 py-1.5 text-sm hover:bg-gray-100 dark:hover:bg-neutral-800">Archive</button>
                                    )}
                                    <button onClick={() => { onDeleteWorkspace(ws); setActiveMenu(null); }} className="block w-full text-left px-3 py-1.5 text-sm text-red-700 hover:bg-gray-100 dark:hover:bg-neutral-800">Delete</button>
                                </div>
                            )}
                        </li>
                    ))}
                    <li>
                        <button onClick={onCreateWorkspace} className="w-full text-left px-3 py-2.5 rounded-lg text-sm font-medium transition-colors duration-200 flex items-center text-gray-500 dark:text-neutral-400 hover:text-gray-800 dark:hover:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-800">
                            <PlusIcon className="w-5 h-5 flex-shrink-0" />
                            <span className={`ml-3 truncate transition-opacity duration-200 ${isCollapsed ? 'opacity-0' : 'opacity-100'}`}>Create Workspace</span>
                        </button>
                    </li>
                </ul>
                {archivedWorkspaces.length > 0 && !isCollapsed && (
                     <div className="mt-4 px-3">
                        <label className="flex items-center space-x-2 cursor-pointer">
                            <input type="checkbox" checked={showArchived} onChange={() => setShowArchived(!showArchived)} className="h-4 w-4 rounded border-gray-300 dark:border-neutral-600 text-red-700 focus:ring-red-700 bg-gray-100 dark:bg-neutral-800"/>
                            <span className="text-sm text-gray-500 dark:text-neutral-400">Show archived</span>
                        </label>
                    </div>
                 )}
            </nav>

            <div ref={profileRef} className="p-4 border-t border-gray-200 dark:border-neutral-800 flex-shrink-0 relative mt-auto">
                {isProfileOpen && <UserProfileDropdown navigateTo={navigateTo} onLogout={onLogout} onManageMembers={onManageMembers} />}
                <button onClick={() => setProfileOpen(o => !o)} className={`w-full flex items-center p-2 rounded-lg transition-colors duration-200 hover:bg-gray-100 dark:hover:bg-neutral-800 ${isCollapsed ? 'justify-center' : ''}`}>
                    <div className="w-10 h-10 bg-red-700 rounded-full flex items-center justify-center text-white font-bold text-sm overflow-hidden flex-shrink-0">
                        {currentUser.avatar ? <img src={currentUser.avatar} alt={currentUser.name} className="w-full h-full object-cover" /> : getInitials(currentUser.name)}
                    </div>
                    <div className={`ml-3 overflow-hidden text-left transition-all duration-300 ease-in-out ${isCollapsed ? 'w-0 opacity-0' : 'w-auto opacity-100'}`}>
                        <p className="font-semibold text-gray-800 dark:text-neutral-200 text-sm truncate">{currentUser.name}</p>
                    </div>
                </button>
            </div>
        </aside>
    );
};

const TopNavbar: React.FC<Pick<LayoutProps, 'currentWorkspace' | 'navigateTo'>> = 
({ currentWorkspace, navigateTo }) => {
    if (!currentWorkspace) {
        return <header className="bg-white dark:bg-neutral-900 h-[73px] px-6 border-b border-gray-200 dark:border-neutral-800 flex-shrink-0 z-10" />;
    }

    // Only show workspace + project scores if we're on the Analysis screen
    if (navigateTo !== Screen.Analysis) {
        return (
            <header className="bg-white dark:bg-neutral-900 h-[73px] px-6 border-b border-gray-200 dark:border-neutral-800 flex-shrink-0 z-10 flex items-center">
                <h1 className="text-lg font-bold text-gray-800 dark:text-neutral-50 truncate">{currentWorkspace.name}</h1>
            </header>
        );
    }

    // If we ARE on Analysis screen → show the full row
    return (
        <header className="bg-white dark:bg-neutral-900 px-6 border-b border-gray-200 dark:border-neutral-800 flex justify-between items-center flex-shrink-0 z-10 h-[73px]">
            <div className="flex items-center space-x-6">
                <div>
                    <p className="text-sm text-gray-500 dark:text-neutral-500">Current Workspace</p>
                    <h1 className="text-lg font-bold text-gray-800 dark:text-neutral-50">{currentWorkspace.name}</h1>
                </div>
                <div>
                    <p className="text-sm text-gray-500 dark:text-neutral-500">Document Title</p>
                    <h2 className="text-md font-semibold text-gray-700 dark:text-neutral-200">Example.docx</h2>
                </div>
                <div>
                    <p className="text-sm text-gray-500 dark:text-neutral-500">Project Scores</p>
                    <h2 className="text-md font-semibold text-gray-700 dark:text-neutral-200">92%</h2>
                </div>
                <button className="px-4 py-2 bg-red-700 text-white rounded-lg hover:bg-red-800 transition">Auto Enhance</button>
            </div>
        </header>
    );
};




export const Layout: React.FC<LayoutProps> = (props) => {
    const { children } = props;
    const [isSidebarCollapsed, setSidebarCollapsed] = useState(localStorage.getItem('vesta-sidebar-collapsed') === 'true');

    const handleToggleCollapse = () => {
        const newState = !isSidebarCollapsed;
        setSidebarCollapsed(newState);
        localStorage.setItem('vesta-sidebar-collapsed', String(newState));
    };
    
    return (
        <div className="flex h-screen bg-gray-100 dark:bg-neutral-950 overflow-hidden">
            <WorkspaceSidebar {...props} isCollapsed={isSidebarCollapsed} onToggleCollapse={handleToggleCollapse} />
            <div className="flex-1 flex flex-col overflow-hidden">
            <TopNavbar currentWorkspace={props.currentWorkspace} navigateTo={props.navigateTo} />
                <main className="flex-1 overflow-y-auto">
                    {children}
                </main>
            </div>
        </div>
    );
};

export const CenteredLayout: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-neutral-950 font-sans p-4">
        {children}
    </div>
);