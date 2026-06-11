import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import Map from '@arcgis/core/Map';
import MapView from '@arcgis/core/views/MapView';
import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer';
import Graphic from '@arcgis/core/Graphic';
import Polygon from '@arcgis/core/geometry/Polygon';
import SketchViewModel from '@arcgis/core/widgets/Sketch/SketchViewModel';

// 🛡️ PERSISTENT MAP CORE VARIABLES
let globalSpatialMap = null;
let globalMapView = null;
let globalGraphicsLayer = null;
let globalSketchViewModel = null;

// 💲 VALUATION DISPLAY HELPERS
// lma/ima may arrive as numbers, numeric strings, NULL, the literal text
// "UNASSIGNED", or DCAD's $0/$1 placeholder amounts.
const formatValuation = (raw) => {
    const num = parseFloat(raw);
    if (Number.isNaN(num) || num <= 1) return "Unassigned";
    return `$${num.toLocaleString()}`;
};

// 🧱 Hard cap on registry cards rendered per dashboard tab (browser safety)
const MAX_REGISTRY_RENDER = 300;

// Numeric coercion for arithmetic (non-numeric -> 0)
const toNum = (raw) => {
    const num = parseFloat(raw);
    return Number.isNaN(num) ? 0 : num;
};

// -------------------------------------------------------------------------
// ⚖️ INTERNAL PROTEST QUEUE DASHBOARD COMPONENT (With Detailed Review Modal)
// -------------------------------------------------------------------------
function ProtestQueueDashboard({ userRole, authToken, handleRegistryItemClick }) {
    const [queue, setQueue] = useState([]);
    const [loading, setLoading] = useState(true);
    
    // State to track which protest item is currently open in the pop-up modal
    const [selectedProtest, setSelectedProtest] = useState(null);
    
    // Working state values for the form inside the modal workspace
    const [reviewStatus, setReviewStatus] = useState("");
    const [appraisalNotes, setAppraisalNotes] = useState("");
    const [reducedValue, setReducedValue] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);

    const loadQueueData = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch("http://127.0.0.1:8000/api/protests/queue", {
                headers: { "Authorization": `Bearer ${authToken}` }
            });
            const data = await res.json();
            if (Array.isArray(data)) setQueue(data);
        } catch (err) { console.error("Protest Queue load failed:", err); }
        setLoading(false);
    }, [authToken]);

    useEffect(() => { loadQueueData(); }, [loadQueueData]);

    const openReviewModal = (protest) => {
        setSelectedProtest(protest);
        setReviewStatus(protest.status || "Under Review");
        setAppraisalNotes(protest.appraisal_notes || "");
        setReducedValue(protest.reduced_value || "");
    };

    const closeReviewModal = () => {
        setSelectedProtest(null);
        setReviewStatus("");
        setAppraisalNotes("");
        setReducedValue("");
    };

    const handleFormSubmitEvaluation = async (e) => {
        e.preventDefault();
        if (!selectedProtest) return;
        
        setIsSubmitting(true);
        try {
            const payload = {
                status: reviewStatus,
                appraisal_notes: appraisalNotes,
                outcome: reviewStatus === "Resolved" ? "Value Adjusted" : null,
                reduced_value: reviewStatus === "Resolved" && reducedValue ? parseFloat(reducedValue) : null
            };

            const res = await fetch(`http://127.0.0.1:8000/api/protests/${selectedProtest.protest_id}/evaluate`, {
                method: "PATCH",
                headers: { 
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${authToken}`
                },
                body: JSON.stringify(payload)
            });

            if (res.ok) {
                closeReviewModal();
                loadQueueData();
            } else {
                const errData = await res.json();
                alert(`Error saving adjustments: ${errData.detail || "Unknown error"}`);
            }
        } catch (err) { 
            console.error("Evaluation update failed:", err); 
        } finally {
            setIsSubmitting(false);
        }
    };

    const handlePurgeRecord = async (protestId) => {
        if (!window.confirm("CRITICAL WARNING: Are you sure you want to permanently delete this legal application out of the tracking database? This action is unbacked and logged.")) return;
        try {
            await fetch(`http://127.0.0.1:8000/api/protests/${protestId}/purge`, {
                method: "DELETE",
                headers: { "Authorization": `Bearer ${authToken}` }
            });
            if (selectedProtest && selectedProtest.protest_id === protestId) {
                closeReviewModal();
            }
            loadQueueData();
        } catch (err) { console.error("Purging file sequence aborted:", err); }
    };

    if (loading) return <div style={{ padding: "20px", fontSize: "12px", textAlign: "center", color: "#64748b" }}>Loading active appraisal disputes...</div>;

    return (
        <div style={{ background: "#ffffff", height: "100%", overflowY: "auto", position: "relative" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "11px" }}>
                <thead>
                    <tr style={{ background: "#f8fafc", textAlign: "left", borderBottom: "2px solid #e2e8f0" }}>
                        <th style={{ padding: "8px" }}>Account</th>
                        <th style={{ padding: "8px" }}>Reason (Click row to read full text)</th>
                        <th style={{ padding: "8px" }}>Orig Value</th>
                        <th style={{ padding: "8px" }}>Status</th>
                        <th style={{ padding: "8px" }}>Actions</th>
                    </tr>
                </thead>
                <tbody>
                    {queue.map(p => (
                        <tr 
                            key={p.protest_id} 
                            style={{ borderBottom: "1px solid #e2e8f0", cursor: "pointer" }}
                            className="hover:bg-slate-50"
                            onClick={() => openReviewModal(p)}
                        >
                            <td 
                                style={{ padding: "8px", color: "#0284c7", fontWeight: "bold", fontFamily: "monospace" }}
                                onClick={(e) => {
                                    e.stopPropagation(); 
                                    handleRegistryItemClick(p.account_num);
                                }} 
                            >
                                {p.account_num}
                            </td>
                            <td style={{ padding: "8px", maxWidth: "150px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {p.protest_reason}
                            </td>
                            <td style={{ padding: "8px" }}>${parseFloat(p.original_value || 0).toLocaleString()}</td>
                            <td style={{ padding: "8px" }}>
                                <span style={{ 
                                    padding: "2px 6px", borderRadius: "4px", fontSize: "9px", 
                                    background: p.status === "Resolved" ? "#dcfce7" : p.status === "Under Review" ? "#e0f2fe" : "#fef9c3", 
                                    color: p.status === "Resolved" ? "#15803d" : p.status === "Under Review" ? "#0369a1" : "#a16207", 
                                    fontWeight: "bold", textTransform: "uppercase" 
                                }}>
                                    {p.status}
                                </span>
                            </td>
                            <td style={{ padding: "8px" }} onClick={(e) => e.stopPropagation()}>
                                <div style={{ display: "flex", gap: "4px" }}>
                                    <button 
                                        onClick={() => openReviewModal(p)}
                                        style={{ background: "#0284c7", color: "#fff", border: "none", padding: "4px 8px", borderRadius: "3px", cursor: "pointer", fontSize: "9px" }}
                                    >
                                        View / Edit
                                    </button>
                                    
                                    {userRole === 'admin' && (
                                        <button 
                                            onClick={() => handlePurgeRecord(p.protest_id)}
                                            style={{ background: "#ef4444", color: "#fff", border: "none", padding: "4px 8px", borderRadius: "3px", cursor: "pointer", fontSize: "9px", fontWeight: "bold" }}
                                        >
                                            Purge 🗑️
                                        </button>
                                    )}
                                </div>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>

            {/* 📥 DYNAMIC DETAILED ENTRY MODAL OVERLAY */}
            {selectedProtest && (
                <div style={{
                    position: "fixed", top: 0, left: 0, width: "100vw", height: "100vh",
                    backgroundColor: "rgba(15, 23, 42, 0.6)", zIndex: 9999,
                    display: "flex", justifyContent: "center", alignItems: "center", padding: "20px"
                }}>
                    <div style={{
                        background: "#ffffff", borderRadius: "8px", width: "100%", maxWidth: "550px",
                        boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.1)", display: "flex", flexDirection: "column", overflow: "hidden"
                    }}>
                        <div style={{ background: "#0f172a", color: "#ffffff", padding: "14px 20px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <div>
                                <h3 style={{ margin: 0, fontSize: "14px", fontWeight: "bold" }}>Protest File #{selectedProtest.protest_id}</h3>
                                <p style={{ margin: "2px 0 0 0", fontSize: "11px", color: "#94a3b8", fontFamily: "monospace" }}>Account Reference: {selectedProtest.account_num}</p>
                            </div>
                            <button onClick={closeReviewModal} style={{ background: "transparent", color: "#94a3b8", border: "none", fontSize: "20px", cursor: "pointer" }}>&times;</button>
                        </div>

                        <form onSubmit={handleFormSubmitEvaluation} style={{ padding: "20px", display: "flex", flexDirection: "column", gap: "14px", overflowY: "auto", maxHeight: "calc(100vh - 150px)" }}>
                            <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "6px", padding: "12px" }}>
                                <label style={{ display: "block", fontSize: "11px", fontWeight: "bold", color: "#475569", marginBottom: "4px", textTransform: "uppercase" }}>
                                    Citizen Protest Reason Statement (Full View):
                                </label>
                                <div style={{ fontSize: "12px", color: "#1e293b", lineHeight: "1.5", whiteSpace: "pre-wrap", maxHeight: "150px", overflowY: "auto" }}>
                                    {selectedProtest.protest_reason}
                                </div>
                            </div>

                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                                <div>
                                    <label style={{ display: "block", fontSize: "11px", color: "#64748b", fontWeight: "600" }}>Original Baseline Market Value:</label>
                                    <span style={{ fontSize: "13px", fontWeight: "bold", color: "#0f172a" }}>
                                        ${parseFloat(selectedProtest.original_value || 0).toLocaleString()}
                                    </span>
                                </div>
                                <div>
                                    <label style={{ display: "block", fontSize: "11px", color: "#64748b", fontWeight: "600" }}>Current Status:</label>
                                    <span style={{ 
                                        display: "inline-block", padding: "2px 6px", borderRadius: "4px", fontSize: "10px", fontWeight: "bold", marginTop: "2px",
                                        background: selectedProtest.status === "Resolved" ? "#dcfce7" : selectedProtest.status === "Under Review" ? "#e0f2fe" : "#fef9c3", 
                                        color: selectedProtest.status === "Resolved" ? "#15803d" : selectedProtest.status === "Under Review" ? "#0369a1" : "#a16207", 
                                    }}>
                                        {selectedProtest.status}
                                    </span>
                                </div>
                            </div>

                            <hr style={{ border: 0, borderTop: "1px solid #e2e8f0", margin: "4px 0" }} />

                            {userRole === 'analyst' ? (
                                <div>
                                    <p style={{ color: "#64748b", fontSize: "11px", fontStyle: "italic", margin: "0 0 8px 0" }}>
                                        Note: Your role scope (Analyst) is assigned Read-Only auditing rights for individual entries.
                                    </p>
                                    <div style={{ background: "#f1f5f9", padding: "10px", borderRadius: "4px", fontSize: "11px", color: "#334155" }}>
                                        <strong>Appraiser Logs:</strong> {selectedProtest.appraisal_notes || "No notes documented yet."}
                                    </div>
                                </div>
                            ) : (
                                <>
                                    <div>
                                        <label style={{ display: "block", fontSize: "11px", fontWeight: "bold", color: "#334155", marginBottom: "6px" }}>Set Evaluation Track:</label>
                                        <div style={{ display: "flex", gap: "15px" }}>
                                            <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", cursor: "pointer" }}>
                                                <input type="radio" name="reviewStatus" value="Under Review" checked={reviewStatus === "Under Review"} onChange={(e) => setReviewStatus(e.target.value)} />
                                                Under Review
                                            </label>
                                            <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", cursor: "pointer" }}>
                                                <input type="radio" name="reviewStatus" value="Resolved" checked={reviewStatus === "Resolved"} onChange={(e) => setReviewStatus(e.target.value)} />
                                                Approve / Resolve Case
                                            </label>
                                        </div>
                                    </div>

                                    {reviewStatus === "Resolved" && (
                                        <div>
                                            <label style={{ display: "block", fontSize: "11px", fontWeight: "bold", color: "#334155", marginBottom: "4px" }}>
                                                Adjusted Reduced Valuation ($):
                                            </label>
                                            <input type="number" value={reducedValue} onChange={(e) => setReducedValue(e.target.value)} placeholder={((selectedProtest.original_value || 0) * 0.9).toString()} style={{ width: "100%", padding: "6px 10px", border: "1px solid #cbd5e1", borderRadius: "4px", fontSize: "12px" }} required />
                                        </div>
                                    )}

                                    <div>
                                        <label style={{ display: "block", fontSize: "11px", fontWeight: "bold", color: "#334155", marginBottom: "4px" }}>
                                            Appraisal Notes / Adjustment Log:
                                        </label>
                                        <textarea rows="4" value={appraisalNotes} onChange={(e) => setAppraisalNotes(e.target.value)} placeholder="Specify evaluation details..." style={{ width: "100%", padding: "8px", border: "1px solid #cbd5e1", borderRadius: "4px", fontSize: "12px", fontFamily: "sans-serif", resize: "vertical" }} />
                                    </div>
                                </>
                            )}

                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "10px", borderTop: "1px solid #e2e8f0", paddingTop: "14px" }}>
                                <div>
                                    {userRole === 'admin' && (
                                        <button type="button" onClick={() => handlePurgeRecord(selectedProtest.protest_id)} style={{ background: "#ef4444", color: "#ffffff", border: "none", padding: "6px 12px", borderRadius: "4px", cursor: "pointer", fontSize: "11px", fontWeight: "bold" }}>
                                            Delete Permanently
                                        </button>
                                    )}
                                </div>
                                <div style={{ display: "flex", gap: "8px" }}>
                                    <button type="button" onClick={closeReviewModal} style={{ background: "#e2e8f0", color: "#334155", border: "none", padding: "6px 12px", borderRadius: "4px", cursor: "pointer", fontSize: "11px" }}>
                                        {userRole === 'analyst' ? "Close File" : "Cancel"}
                                    </button>
                                    {userRole !== 'analyst' && (
                                        <button type="submit" disabled={isSubmitting} style={{ background: "#10b981", color: "#ffffff", border: "none", padding: "6px 16px", borderRadius: "4px", cursor: "pointer", fontSize: "11px", fontWeight: "bold" }}>
                                            {isSubmitting ? "Saving Adjustments..." : "Save Decisions"}
                                        </button>
                                    )}
                                </div>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}

// -------------------------------------------------------------------------
// 📐 INTERNAL TOPOLOGY QA LOG DASHBOARD WRAPPER
// -------------------------------------------------------------------------
function TopologyQADashboard({ userRole, authToken, handleRegistryItemClick }) {
    const [issues, setIssues] = useState([]);
    const [loading, setLoading] = useState(true);
    const [processingId, setProcessingId] = useState(null);

    const loadQAData = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch("http://127.0.0.1:8000/api/qa/issues", {
                headers: { "Authorization": `Bearer ${authToken}` }
            });
            const data = await res.json();
            if (Array.isArray(data)) setIssues(data);
        } catch (err) { console.error("Failed to load QA boundary issues:", err); }
        setLoading(false);
    }, [authToken]);

    useEffect(() => { loadQAData(); }, [loadQAData]);

    const handleRemediateIssue = async (issueId) => {
        if (!window.confirm("Execute PostGIS automated correction algorithm on this boundary feature?")) return;
        
        setProcessingId(issueId);
        try {
            const res = await fetch(`http://127.0.0.1:8000/api/qa/resolve-issue/${issueId}`, {
                method: "POST",
                headers: { "Authorization": `Bearer ${authToken}` }
            });
            
            if (res.ok) {
                alert("Geometry successfully repaired in spatial warehouse!");
                loadQAData(); 
            } else {
                const err = await res.json();
                alert(`Remediation aborted: ${err.detail || "Server processing error"}`);
            }
        } catch (err) {
            console.error("Remediation connection broke:", err);
        } finally {
            setProcessingId(null);
        }
    };

    if (loading) return <div style={{ padding: "20px", fontSize: "12px", textAlign: "center", color: "#64748b" }}>Scanning spatial layers for topology violations...</div>;

    return (
        <div style={{ background: "#ffffff", height: "100%", overflowY: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "11px" }}>
                <thead>
                    <tr style={{ background: "#f8fafc", textAlign: "left", borderBottom: "2px solid #e2e8f0" }}>
                        <th style={{ padding: "8px" }}>Account No</th>
                        <th style={{ padding: "8px" }}>Anomaly Class</th>
                        <th style={{ padding: "8px" }}>Description</th>
                        <th style={{ padding: "8px" }}>Severity</th>
                        <th style={{ padding: "8px" }}>Operations</th>
                    </tr>
                </thead>
                <tbody>
                    {issues.filter(i => i.status === 'OPEN').map(issue => (
                        <tr key={issue.issue_id} style={{ borderBottom: "1px solid #e2e8f0" }}>
                            <td 
                                style={{ padding: "8px", color: "#0284c7", fontWeight: "bold", cursor: "pointer" }}
                                onClick={() => handleRegistryItemClick(issue.account_num)}
                            >
                                {issue.account_num}
                            </td>
                            <td style={{ padding: "8px", fontWeight: "600" }}>{issue.issue_type}</td>
                            <td style={{ padding: "8px", color: "#475569" }}>{issue.description}</td>
                            <td style={{ padding: "8px" }}>
                                <span style={{
                                    padding: "2px 6px", borderRadius: "4px", fontSize: "9px", fontWeight: "bold",
                                    background: issue.severity === 'CRITICAL' || issue.severity === 'HIGH' ? '#fee2e2' : '#fef3c7',
                                    color: issue.severity === 'CRITICAL' || issue.severity === 'HIGH' ? '#991b1b' : '#92400e'
                                }}>
                                    {issue.severity}
                                </span>
                            </td>
                            <td style={{ padding: "8px" }}>
                                {['gis_editor', 'gis_editor_user', 'admin'].includes(userRole) ? (
                                    <button
                                        disabled={processingId === issue.issue_id}
                                        onClick={() => handleRemediateIssue(issue.issue_id)}
                                        style={{
                                            background: "#10b981", color: "#fff", border: "none", 
                                            padding: "4px 8px", borderRadius: "3px", cursor: "pointer", 
                                            fontSize: "10px", fontWeight: "bold"
                                        }}
                                    >
                                        {processingId === issue.issue_id ? "Fixing..." : "Auto-Fix 🛠️"}
                                    </button>
                                ) : (
                                    <span style={{ color: "#94a3b8", fontStyle: "italic", fontSize: "10px" }}>Read-Only</span>
                                )}
                            </td>
                        </tr>
                    ))}
                    {issues.filter(i => i.status === 'OPEN').length === 0 && (
                        <tr>
                            <td colSpan="5" style={{ padding: "20px", textAlign: "center", color: "#64748b" }}>
                                🎉 Authoritative check passed! No open topology errors detected in current layer fabric.
                            </td>
                        </tr>
                    )}
                </tbody>
            </table>
        </div>
    );
}

// -------------------------------------------------------------------------
// 🗺️ MASTER FRONTEND GIS MAP COMPONENT
// -------------------------------------------------------------------------
export default function ParcelMap() {
    const mapContainer = useRef(null);

    // 🔑 LIVE SECURITY STATE CORE LAYER
    const [authToken, setAuthToken] = useState(""); 
    const [userRole, setUserRole] = useState("public"); 
    const [showLoginPanel, setShowLoginPanel] = useState(false);
    const [loginUsername, setLoginUsername] = useState("");
    const [loginPassword, setLoginPassword] = useState("");
    const [loginError, setLoginError] = useState("");
    const [authLoading, setAuthLoading] = useState(false);

    // 🎛️ Map Locator & Selection State Matrix
    const [locatorInput, setLocatorInput] = useState("");
    const [selectedAccount, setSelectedAccount] = useState("");
    const [parcelMetadata, setParcelMetadata] = useState(null);
    const [querying, setQuerying] = useState(false);
    const [searchError, setSearchError] = useState("");

    // ⚖️ Public Protest Form & Modal Toggles
    const [showProtestModal, setShowProtestModal] = useState(false);
    const [protestReason, setProtestReason] = useState("");
    const [protestStatusMsg, setProtestStatusMsg] = useState("");
    const [submittingProtest, setSubmittingProtest] = useState(false);

    // 📐 Geometry Editor State (Admins & GIS Editors)
    const [editorMode, setEditorMode] = useState(false);
    const [savingGeometry, setSavingGeometry] = useState(false);

    // ⏳ Custom Undo/Redo State Engine
    const [undoStack, setUndoStack] = useState([]);
    const [redoStack, setRedoStack] = useState([]);
    const [currentGeomState, setCurrentGeomState] = useState(null);

    // 🗂️ Master Account Registry List State Matrix
    const [directoryList, setDirectoryList] = useState([]);
    const [pageOffset, setPageOffset] = useState(0);
    const [listLoading, setListLoading] = useState(false);
    const [registrySearch, setRegistrySearch] = useState(""); 
    const LIMIT = 50; 

    // 🕹️ Sub-Module Tab Management Engine
    const [activeTab, setActiveTab] = useState("directory"); 
    const [moduleData, setModuleData] = useState([]);
    const [moduleLoading, setModuleLoading] = useState(false);
    const [moduleError, setModuleError] = useState(""); 

    const parcelSymbol = {
        type: "simple-fill",
        color: [0, 255, 255, 0.25],        
        outline: { color: [0, 255, 255, 1], width: 2.0 }
    };

    const definitionMatrixTabs = [
        { id: "directory", label: "📁 Registry", access: ["public", "gis_editor", "gis_editor_user", "appraiser", "analyst", "admin"] },
        { id: "change_detect", label: "🔍 Imagery", access: ["public", "appraiser", "analyst", "admin"] },
        { id: "qa_rules", label: "⚠️ Topology", access: ["gis_editor", "gis_editor_user", "appraiser", "analyst", "admin"] },
        { id: "protests", label: "⚖️ Protest Board", access: ["appraiser", "analyst", "admin"] },
        { id: "ml_analytics", label: "🤖 ML Outliers", access: ["analyst", "admin"] }
    ];

    const visibleTabs = useMemo(() => {
        return definitionMatrixTabs.filter(tab => tab.access.includes(userRole));
    }, [userRole]);

    useEffect(() => {
        const isCurrentTabPermitted = visibleTabs.some(t => t.id === activeTab);
        if (!isCurrentTabPermitted && visibleTabs.length > 0) setActiveTab(visibleTabs[0].id);
    }, [visibleTabs, activeTab]);

    const handleEnterpriseLoginSubmit = (e) => {
        e.preventDefault();
        setLoginError("");
        setAuthLoading(true);

        fetch("http://127.0.0.1:8000/api/auth/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username: loginUsername, password: loginPassword })
        })
        .then(async (res) => {
            const data = await res.json();
            if (!res.ok) throw new Error(data.detail || "Authentication validation failed.");
            return data;
        })
        .then((data) => {
            setAuthToken(data.access_token);
            setUserRole(data.role || "public"); 
            setShowLoginPanel(false); 
            setLoginUsername("");
            setLoginPassword("");
            setAuthLoading(false);
            setModuleError(""); 
        })
        .catch((err) => {
            setLoginError(err.message);
            setAuthLoading(false);
        });
    };

    const handleSystemSignOut = () => {
        setAuthToken("");
        setUserRole("public");
        handleClearSelection();
        setActiveTab("directory");
        setModuleError("");
        setEditorMode(false);
    };

    const fetchDirectoryPage = useCallback((offset, searchParam = "") => {
        setListLoading(true);
        fetch(`http://127.0.0.1:8000/api/parcels/list?limit=${LIMIT}&offset=${offset}&search=${searchParam}`)
            .then((res) => res.json())
            .then((data) => {
                setDirectoryList(data);
                setListLoading(false);
            })
            .catch((err) => {
                console.error("Directory index fetch error:", err);
                setListLoading(false);
            });
    }, []);

    const fetchModuleDashboardData = useCallback((targetTab) => {
        if (targetTab === "directory" || targetTab === "protests") return; 
        setModuleLoading(true);
        setModuleData([]);
        setModuleError(""); 

        const endpointMap = {
            change_detect: "change-detections",
            qa_rules: "qa-issues",
            ml_analytics: "ml-analytics"
        };

        const targetEndpoint = endpointMap[targetTab];
        const fetchHeaders = authToken ? { 'Authorization': `Bearer ${authToken}` } : {};

        fetch(`http://127.0.0.1:8000/api/dashboard/${targetEndpoint}`, { headers: fetchHeaders })
            .then((res) => {
                if (res.status === 401 || res.status === 403) throw new Error("🔒 Clearance required to view this module. Please log in.");
                if (!res.ok) throw new Error("Access forbidden on this data structure tier.");
                return res.json();
            })
            .then((data) => {
                setModuleData(data);
                setModuleLoading(false);
            })
            .catch((err) => {
                setModuleError(err.message); 
                setModuleLoading(false);
            });
    }, [authToken]);

    // Snapshot Geometry to allow for Undo/Redo Engine Tracking
    const saveStateForUndo = useCallback((previousState) => {
        setUndoStack(prev => [...prev, previousState]);
        setRedoStack([]);
    }, []);

    const applyGeometryState = (stateObj) => {
        if (!globalGraphicsLayer || !stateObj) return;
        globalGraphicsLayer.removeAll();

        const restoredGraphic = new Graphic({
            geometry: Polygon.fromJSON(stateObj.geometry),
            symbol: parcelSymbol,
            attributes: stateObj.attributes
        });

        globalGraphicsLayer.add(restoredGraphic);
    };

    const handleUndo = useCallback(() => {
        if (globalSketchViewModel && (globalSketchViewModel.state === "active" || globalSketchViewModel.state === "update")) {
            if (globalSketchViewModel.canUndo()) {
                globalSketchViewModel.undo();
                return;
            }
        }
        if (undoStack.length === 0) return;

        const previousState = undoStack[undoStack.length - 1];
        const newUndoStack = undoStack.slice(0, -1);

        if (currentGeomState) setRedoStack(prev => [...prev, currentGeomState]);
        applyGeometryState(previousState);
        setUndoStack(newUndoStack);
        setCurrentGeomState(previousState);
    }, [undoStack, currentGeomState]);

    const handleRedo = useCallback(() => {
        if (globalSketchViewModel && (globalSketchViewModel.state === "active" || globalSketchViewModel.state === "update")) {
            if (globalSketchViewModel.canRedo()) {
                globalSketchViewModel.redo();
                return;
            }
        }
        if (redoStack.length === 0) return;

        const nextState = redoStack[redoStack.length - 1];
        const newRedoStack = redoStack.slice(0, -1);

        if (currentGeomState) setUndoStack(prev => [...prev, currentGeomState]);
        applyGeometryState(nextState);
        setRedoStack(newRedoStack);
        setCurrentGeomState(nextState);
    }, [redoStack, currentGeomState]);

    useEffect(() => {
        const handleKeyDown = (event) => {
            if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') return;
            const isCtrlOrCmd = event.ctrlKey || event.metaKey; 
            if (isCtrlOrCmd && event.key.toLowerCase() === 'z') {
                event.preventDefault(); 
                handleUndo();
            }
            if (isCtrlOrCmd && event.key.toLowerCase() === 'y') {
                event.preventDefault();
                handleRedo();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [handleUndo, handleRedo]);

    const loadParcelToCanvas = (targetId) => {
        if (!targetId || !globalMapView || !globalGraphicsLayer) return;

        setQuerying(true);
        setSearchError("");
        setProtestReason("");     
        setProtestStatusMsg("");  
        setEditorMode(false);
        setUndoStack([]);
        setRedoStack([]);

        fetch(`http://127.0.0.1:8000/api/account/${targetId}`)
            .then((res) => {
                if (!res.ok) throw new Error("Account records do not exist in system index.");
                return res.json();
            })
            .then((geoJsonCollection) => {
                setQuerying(false);
                
                if (!geoJsonCollection.features || geoJsonCollection.features.length === 0) {
                    setSearchError(`Account "${targetId}" not found in cadastral warehouse.`);
                    return;
                }

                const targetFeature = geoJsonCollection.features[0];
                const rawCoords = targetFeature.geometry.coordinates;
                
                globalGraphicsLayer.removeAll();

                let polygonRings = [];
                if (targetFeature.geometry.type === "Polygon") {
                    polygonRings = rawCoords;
                } else if (targetFeature.geometry.type === "MultiPolygon") {
                    rawCoords.forEach(poly => {
                        poly.forEach(ring => { polygonRings.push(ring); });
                    });
                }

                const parcelGeometry = new Polygon({
                    rings: polygonRings,
                    spatialReference: { wkid: 4326 } 
                });

                const parcelGraphic = new Graphic({
                    geometry: parcelGeometry,
                    symbol: parcelSymbol,
                    attributes: targetFeature.properties
                });

                globalGraphicsLayer.add(parcelGraphic);
                setSelectedAccount(targetId);
                setParcelMetadata(targetFeature.properties);
                
                setCurrentGeomState({
                    geometry: parcelGeometry.toJSON(),
                    attributes: { ...targetFeature.properties }
                });

                globalMapView.goTo({
                    target: parcelGeometry.extent.expand(1.6),
                    zoom: 17
                }, { duration: 900 });
            })
            .catch((err) => {
                setQuerying(false);
                setSearchError("Property identity lookup failed.");
            });
    };

    const handleClearSelection = () => {
        setSelectedAccount("");
        setParcelMetadata(null);
        setSearchError("");
        setProtestReason("");
        setProtestStatusMsg("");
        setShowProtestModal(false);
        setEditorMode(false);
        setUndoStack([]);
        setRedoStack([]);
        setCurrentGeomState(null);
        if (globalSketchViewModel) globalSketchViewModel.cancel();
        if (globalGraphicsLayer) globalGraphicsLayer.removeAll();
    };

    const handleRegistryItemClick = (accountNum) => {
        if (selectedAccount === accountNum) {
            handleClearSelection();
        } else {
            loadParcelToCanvas(accountNum);
        }
    };

    const handleLocatorSubmit = (e) => {
        if (e) e.preventDefault();
        const queryTerm = locatorInput.trim();
        if (queryTerm) loadParcelToCanvas(queryTerm);
    };

    const handleProtestSubmit = async (e) => {
        e.preventDefault();
        if (!protestReason.trim() || !selectedAccount) return;
        
        setSubmittingProtest(true);
        setProtestStatusMsg("");
        const fetchHeaders = { "Content-Type": "application/json" };
        if (authToken) fetchHeaders["Authorization"] = `Bearer ${authToken}`;

        try {
            const response = await fetch("http://127.0.0.1:8000/api/protests/submit", {
                method: "POST",
                headers: fetchHeaders,
                body: JSON.stringify({
                    account_num: selectedAccount,
                    appraisal_yr: 2026,
                    protest_reason: protestReason
                })
            });
            const data = await response.json();
            if (response.ok && data.status === "SUCCESS") {
                setProtestStatusMsg(`✅ Protest submitted successfully! Tracking ID: ${data.protest_id}`);
                setProtestReason("");
                setTimeout(() => { setShowProtestModal(false); setProtestStatusMsg(""); }, 2500);
            } else {
                setProtestStatusMsg(`❌ Filing failed: ${data.detail || "Access Denied via Authorization Controls."}`);
            }
        } catch (err) {
            setProtestStatusMsg("❌ Critical communication error contacting the appraisal network backend.");
        } finally {
            setSubmittingProtest(false);
        }
    };

    useEffect(() => {
        if (activeTab === "directory") fetchDirectoryPage(pageOffset, registrySearch.trim());
    }, [pageOffset, registrySearch, activeTab, fetchDirectoryPage]);

    useEffect(() => {
        fetchModuleDashboardData(activeTab);
    }, [activeTab, fetchModuleDashboardData]);

    const mapActionsRef = useRef(null);
    mapActionsRef.current = {
        onMapClickHit: (attr) => {
            setSelectedAccount(attr.account_num);
            setParcelMetadata(attr);
            setProtestReason("");
            setProtestStatusMsg("");
            setEditorMode(false);
            if (globalSketchViewModel) globalSketchViewModel.cancel();
        },
        onMapClickMiss: () => { handleClearSelection(); }
    };

    // INTEGRATION: Dynamic DOM Container Re-binding Implementation
    useEffect(() => {
        if (!mapContainer.current) return;
        if (!globalSpatialMap) {
            globalGraphicsLayer = new GraphicsLayer({ id: "activeParcelHighlights" });
            globalSpatialMap = new Map({ basemap: "satellite", layers: [globalGraphicsLayer] });

            globalMapView = new MapView({
                container: mapContainer.current,
                map: globalSpatialMap,
                center: [-96.8088, 32.7767],
                zoom: 13,
                constraints: { minZoom: 3, maxZoom: 21 }
            });
            
            globalSketchViewModel = new SketchViewModel({
                view: globalMapView,
                layer: globalGraphicsLayer,
                updateOnGraphicClick: false, 
                defaultUpdateOptions: {
                    tool: "reshape", 
                    enableRotation: false,
                    enableScaling: false
                }
            });

            // Event Hook binding SketchViewModel updates into the React custom Undo/Redo Engine Memory
            globalSketchViewModel.on("update", (event) => {
                if (event.state === "complete" || event.state === "active") {
                    const targetGraphic = event.graphics[0];
                    if (targetGraphic) {
                        saveStateForUndo({
                            geometry: targetGraphic.geometry.toJSON(),
                            attributes: { ...targetGraphic.attributes }
                        });
                        setCurrentGeomState({
                            geometry: targetGraphic.geometry.toJSON(),
                            attributes: { ...targetGraphic.attributes }
                        });
                    }
                }
            });

            globalMapView.on("click", (event) => {
                globalMapView.hitTest(event).then((response) => {
                    const graphicResults = response.results.filter(
                        r => r.graphic && r.graphic.layer.id === "activeParcelHighlights"
                    );
                    if (graphicResults.length > 0) {
                        const attrs = graphicResults[0].graphic.attributes;
                        if (attrs && mapActionsRef.current) mapActionsRef.current.onMapClickHit(attrs);
                    } else {
                        if (mapActionsRef.current) mapActionsRef.current.onMapClickMiss();
                    }
                });
            });
        } else {
            if (globalMapView.container !== mapContainer.current) {
                globalMapView.container = mapContainer.current;
            }
        }
        
        // INTEGRATION: Defensively wrapper to prevent crash if instance isn't hydrated yet
        if (globalMapView && typeof globalMapView.tryToResolveResize === "function") {
            globalMapView.when(() => {
                globalMapView.tryToResolveResize()
                    .catch((err) => console.error("Map resize failed:", err));
            });
        }
    }, [saveStateForUndo]);

    return (
        <div style={{ display: "flex", flexDirection: "row", width: "100vw", height: "100vh", fontFamily: "system-ui, sans-serif", position: "relative" }}>
            
            {/* FLOATING ACTION TOOLBAR LAYER */}
            {(undoStack.length > 0 || redoStack.length > 0) && (
                <div style={{ position: "absolute", top: "20px", right: "20px", zIndex: 50, display: "flex", gap: "8px", background: "#ffffff", padding: "8px", borderRadius: "6px", boxShadow: "0 2px 4px rgba(0,0,0,0.1)" }}>
                    <button 
                        onClick={handleUndo} 
                        disabled={undoStack.length === 0}
                        title="Undo (Ctrl+Z)"
                        style={{ padding: "6px 12px", background: undoStack.length === 0 ? "#e2e8f0" : "#0284c7", color: undoStack.length === 0 ? "#94a3b8" : "#ffffff", border: "none", borderRadius: "4px", cursor: "pointer", fontWeight: "bold" }}
                    >
                        ⎌ Undo ({undoStack.length})
                    </button>
                    <button 
                        onClick={handleRedo} 
                        disabled={redoStack.length === 0}
                        title="Redo (Ctrl+Y)"
                        style={{ padding: "6px 12px", background: redoStack.length === 0 ? "#e2e8f0" : "#0284c7", color: redoStack.length === 0 ? "#94a3b8" : "#ffffff", border: "none", borderRadius: "4px", cursor: "pointer", fontWeight: "bold" }}
                    >
                        ⎌ Redo ({redoStack.length})
                    </button>
                </div>
            )}

            {/* LEFT BAR CONTROL INTERFACE AREA */}
            <div style={{ width: "420px", height: "100%", background: "#ffffff", borderRight: "1px solid #e2e8f0", display: "flex", flexDirection: "column", boxShadow: "4px 0 15px rgba(0,0,0,0.05)", zIndex: 5 }}>
                
                {/* BRAND HEADERS WITH EMBEDDED TOGGLE LOGIN ACTIONS */}
                <div style={{ padding: "20px 24px", background: "#0f172a", color: "#ffffff", position: "relative" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                        <div>
                            <h1 style={{ margin: 0, fontSize: "17px", fontWeight: 800, letterSpacing: "-0.5px", color: "#38bdf8" }}>
                                DCAD Spatial Operations
                            </h1>
                            <p style={{ margin: "2px 0 0 0", fontSize: "10px", color: "#94a3b8", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px" }}>
                                Mass Appraisal Hub
                            </p>
                        </div>
                        
                        {authToken ? (
                            <button onClick={handleSystemSignOut} style={{ background: "#334155", color: "#f8fafc", border: "none", padding: "5px 10px", borderRadius: "4px", fontSize: "10px", fontWeight: "bold", cursor: "pointer" }}>
                                Sign Out ✕
                            </button>
                        ) : (
                            <button onClick={() => setShowLoginPanel(!showLoginPanel)} style={{ background: "#0284c7", color: "white", border: "none", padding: "5px 10px", borderRadius: "4px", fontSize: "10px", fontWeight: "bold", cursor: "pointer" }}>
                                🔒 Enterprise Login
                            </button>
                        )}
                    </div>

                    <div style={{ display: "flex", alignItems: "center", gap: "6px", marginTop: "8px" }}>
                        <span style={{ fontSize: "9px", background: "#1e293b", color: userRole === 'public' ? "#94a3b8" : "#38bdf8", padding: "2px 6px", borderRadius: "4px", border: "1px solid #334155", fontWeight: "bold", textTransform: "uppercase" }}>
                            Clearance: {userRole}
                        </span>
                    </div>
                </div>

                {/* SLIDE-DOWN AUTHENTICATION INTERACTION INTERFACE PANEL */}
                {showLoginPanel && (
                    <div style={{ padding: "16px 20px", background: "#f1f5f9", borderBottom: "2px solid #cbd5e1" }}>
                        <form onSubmit={handleEnterpriseLoginSubmit} style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                            <div style={{ fontSize: "11px", fontWeight: "bold", color: "#475569" }}>Internal Staff Access Required</div>
                            <input 
                                type="text" 
                                placeholder="Username" 
                                value={loginUsername}
                                onChange={(e) => setLoginUsername(e.target.value)}
                                style={{ padding: "6px 10px", fontSize: "12px", border: "1px solid #cbd5e1", borderRadius: "4px" }}
                                required
                            />
                            <input 
                                type="password" 
                                placeholder="Password" 
                                value={loginPassword}
                                onChange={(e) => setLoginPassword(e.target.value)}
                                style={{ padding: "6px 10px", fontSize: "12px", border: "1px solid #cbd5e1", borderRadius: "4px" }}
                                required
                            />
                            {loginError && <div style={{ color: "#ef4444", fontSize: "11px" }}>{loginError}</div>}
                            <div style={{ display: "flex", gap: "6px", justifyContent: "flex-end", marginTop: "4px" }}>
                                <button type="button" onClick={() => setShowLoginPanel(false)} style={{ padding: "5px 10px", fontSize: "11px", background: "#cbd5e1", border: "none", borderRadius: "4px", cursor: "pointer" }}>Cancel</button>
                                <button type="submit" disabled={authLoading} style={{ padding: "5px 12px", fontSize: "11px", background: "#0079c1", color: "white", border: "none", borderRadius: "4px", cursor: "pointer", fontWeight: "bold" }}>
                                    {authLoading ? "Verifying..." : "Authenticate"}
                                </button>
                            </div>
                        </form>
                    </div>
                )}

                {/* SEARCH REGISTRY DIRECTORY ROUTER */}
                <div style={{ padding: "16px 20px", borderBottom: "1px solid #f1f5f9" }}>
                    <form onSubmit={handleLocatorSubmit} style={{ display: "flex", gap: "8px" }}>
                        <input 
                            type="text" 
                            value={locatorInput} 
                            onChange={(e) => setLocatorInput(e.target.value)} 
                            placeholder="Locate exact account number..." 
                            style={{ padding: "8px 12px", borderRadius: "4px", border: "1px solid #cbd5e1", flex: 1, fontSize: "13px" }} 
                        />
                        <button type="submit" style={{ padding: "8px 14px", background: "#0079c1", color: "white", border: "none", borderRadius: "4px", cursor: "pointer", fontWeight: "bold", fontSize: "13px" }}>
                            Locate
                        </button>
                    </form>
                    {searchError && <div style={{ color: "#ef4444", fontSize: "11px", marginTop: "6px", fontStyle: "italic" }}>{searchError}</div>}
                </div>

                {/* PRIVILEGE NAVIGATION BAR */}
                <div style={{ 
                    display: "grid", 
                    gridTemplateColumns: `repeat(${visibleTabs.length}, 1fr)`, 
                    gap: "4px", 
                    padding: "10px 16px", 
                    background: "#f8fafc", 
                    borderBottom: "1px solid #e2e8f0" 
                }}>
                    {visibleTabs.map(tab => (
                        <button 
                            key={tab.id}
                            onClick={() => setActiveTab(tab.id)} 
                            style={{
                                padding: "6px 2px",
                                background: activeTab === tab.id ? "#0f172a" : "transparent",
                                color: activeTab === tab.id ? "#38bdf8" : "#64748b",
                                border: "none",
                                borderRadius: "4px",
                                fontSize: "10px",
                                fontWeight: "bold",
                                cursor: "pointer",
                                transition: "all 0.15s",
                                textAlign: "center"
                            }}
                        >
                            {tab.label}
                        </button>
                    ))}
                </div>

                {/* MAIN SCROLLABLE OPERATIONS VIEWPORT WINDOW */}
                <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}>
                    
                    {activeTab === "directory" && (
                        <div>
                            <input 
                                type="text"
                                placeholder="Filter directory index..."
                                value={registrySearch}
                                onChange={(e) => { setRegistrySearch(e.target.value); setPageOffset(0); }}
                                style={{ width: "100%", padding: "8px 12px", borderRadius: "4px", border: "1px solid #e2e8f0", marginBottom: "12px", fontSize: "12px", boxSizing: "border-box" }}
                            />
                            {listLoading ? (
                                <div style={{ textAlign: "center", fontSize: "12px", color: "#64748b", padding: "20px" }}>Indexing Registry Table...</div>
                            ) : (
                                <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                                    {directoryList.map((parcel) => (
                                        <div 
                                            key={parcel.account_num}
                                            onClick={() => handleRegistryItemClick(parcel.account_num)}
                                            style={{
                                                padding: "10px 12px",
                                                background: selectedAccount === parcel.account_num ? "#e0f2fe" : "#f8fafc",
                                                border: selectedAccount === parcel.account_num ? "1px solid #bae6fd" : "1px solid #e2e8f0",
                                                borderRadius: "6px",
                                                cursor: "pointer"
                                            }}
                                        >
                                            <div style={{ fontSize: "13px", fontWeight: "bold", fontFamily: "monospace", color: "#0f172a" }}>{parcel.account_num}</div>
                                            <div style={{ fontSize: "11px", color: "#64748b", marginTop: "2px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{parcel.owner_name1 || "No Owner Registered"}</div>
                                        </div>
                                    ))}
                                </div>
                            )}
                            
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "16px" }}>
                                <button disabled={pageOffset === 0 || listLoading} onClick={() => setPageOffset(prev => Math.max(0, prev - LIMIT))} style={{ padding: "6px 12px", background: pageOffset === 0 ? "#f1f5f9" : "#cbd5e1", border: "none", borderRadius: "4px", cursor: pageOffset === 0 ? "not-allowed" : "pointer", fontSize: "11px", fontWeight: "bold" }}>← Back</button>
                                <span style={{ fontSize: "11px", color: "#64748b" }}>Offset: {pageOffset}</span>
                                <button disabled={directoryList.length < LIMIT || listLoading} onClick={() => setPageOffset(prev => prev + LIMIT)} style={{ padding: "6px 12px", background: directoryList.length < LIMIT ? "#f1f5f9" : "#cbd5e1", border: "none", borderRadius: "4px", cursor: directoryList.length < LIMIT ? "not-allowed" : "pointer", fontSize: "11px", fontWeight: "bold" }}>Next →</button>
                            </div>
                        </div>
                    )}

                    {activeTab === "protests" && (
                        <ProtestQueueDashboard 
                            userRole={userRole} 
                            authToken={authToken} 
                            handleRegistryItemClick={handleRegistryItemClick} 
                        />
                    )}

                    {activeTab !== "directory" && activeTab !== "protests" && (
                        <div>
                            {moduleLoading ? (
                                <div style={{ textAlign: "center", fontSize: "12px", color: "#64748b", padding: "30px" }}>Syncing Workflow Layers...</div>
                            ) : moduleError ? (
                                <div style={{ textAlign: "center", fontSize: "12px", color: "#ef4444", padding: "20px", background: "#fef2f2", borderRadius: "6px", border: "1px solid #fecaca", fontWeight: "500", margin: "10px 0" }}>
                                    {moduleError}
                                </div>
                            ) : moduleData.length === 0 ? (
                                <div style={{ textAlign: "center", fontSize: "12px", color: "#94a3b8", padding: "20px", fontStyle: "italic" }}>No active exceptions identified in this tier.</div>
                            ) : (
                                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>

                                    {moduleData.length > MAX_REGISTRY_RENDER && (
                                        <div style={{ fontSize: "11px", color: "#92400e", background: "#fef3c7", border: "1px solid #fde68a", borderRadius: "6px", padding: "8px 10px", fontWeight: "600" }}>
                                            Showing first {MAX_REGISTRY_RENDER.toLocaleString()} of {moduleData.length.toLocaleString()} records (highest severity first).
                                        </div>
                                    )}

                                    {activeTab === "change_detect" && moduleData.slice(0, MAX_REGISTRY_RENDER).map((cd) => (
                                        <div key={cd.detection_id || cd.account_num} onClick={() => handleRegistryItemClick(cd.account_num)} style={{ padding: "12px", borderLeft: "4px solid #3b82f6", background: "#f8fafc", borderRadius: "0 6px 6px 0", border: "1px solid #e2e8f0", cursor: "pointer" }}>
                                            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", fontFamily: "monospace", fontWeight: "bold", color: "#2563eb" }}>
                                                <span>{cd.account_num}</span>
                                                <span style={{ color: "#1e3a8a", background: "#dbeafe", padding: "1px 5px", borderRadius: "3px", fontSize: "10px" }}>{Math.round((cd.confidence || 0) * 100)}% Match</span>
                                            </div>
                                            <div style={{ fontSize: "12px", fontWeight: "600", color: "#334155", marginTop: "4px" }}>{cd.detection_type}</div>
                                            <div style={{ fontSize: "10px", color: "#94a3b8", marginTop: "2px" }}>Status: {cd.review_status}</div>
                                        </div>
                                    ))}

                                    {activeTab === "qa_rules" && moduleData.slice(0, MAX_REGISTRY_RENDER).map((issue) => (
                                        <div key={issue.issue_id || issue.account_num} onClick={() => handleRegistryItemClick(issue.account_num)} style={{ padding: "12px", borderLeft: issue.severity === "HIGH" ? "4px solid #ef4444" : "4px solid #f59e0b", background: "#f8fafc", borderRadius: "0 6px 6px 0", border: "1px solid #e2e8f0", cursor: "pointer" }}>
                                            <div style={{ fontSize: "12px", fontFamily: "monospace", fontWeight: "bold", color: "#dc2626" }}>{issue.account_num}</div>
                                            <div style={{ fontSize: "12px", fontWeight: "bold", color: "#334155", marginTop: "3px" }}>{issue.issue_type}</div>
                                            <p style={{ margin: "3px 0 0 0", fontSize: "11px", color: "#64748b", lineHeight: "1.4" }}>{issue.description}</p>
                                        </div>
                                    ))}

                                    {activeTab === "ml_analytics" && moduleData.slice(0, MAX_REGISTRY_RENDER).map((ml) => (
                                        <div key={ml.account_num} onClick={() => handleRegistryItemClick(ml.account_num)} style={{ padding: "12px", borderLeft: "4px solid #8b5cf6", background: "#f8fafc", borderRadius: "0 6px 6px 0", border: "1px solid #e2e8f0", cursor: "pointer" }}>
                                            <div style={{ fontSize: "12px", fontFamily: "monospace", fontWeight: "bold", color: "#6d28d9" }}>{ml.account_num}</div>
                                            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px", color: "#475569", marginTop: "4px" }}>
                                                <span>Total Market: {toNum(ml.lma) + toNum(ml.ima) <= 1 ? "Unassigned" : `$${(toNum(ml.lma) + toNum(ml.ima)).toLocaleString()}`}</span>
                                                <span style={{ color: "#dc2626", fontWeight: "bold" }}>Risk: {Math.round((ml.protest_risk_score || 0) * 100)}%</span>
                                            </div>
                                            {ml.anomaly_flag === 1 && (
                                                <div style={{ display: "inline-block", marginTop: "4px", fontSize: "9px", background: "#f3e8ff", color: "#6b21a8", padding: "2px 6px", borderRadius: "4px", fontWeight: "bold" }}>⚠️ ISOLATION FOREST OUTLIER</div>
                                            )}
                                        </div>
                                    ))}

                                </div>
                            )}
                        </div>
                    )}

                </div>

                {/* BOTTOM METADATA ATTRIBUTE OVERLAY SUMMARY CARD */}
                {parcelMetadata && (
                    <div style={{ padding: "20px", background: "#f8fafc", borderTop: "1px solid #e2e8f0", maxHeight: "350px", overflowY: "auto" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
                            <h3 style={{ margin: 0, fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.5px", color: "#64748b", fontWeight: "bold" }}>
                                Selected Property Metrics
                            </h3>
                            <button onClick={handleClearSelection} style={{ background: "#fee2e2", border: "none", color: "#dc2626", fontSize: "11px", fontWeight: "bold", cursor: "pointer", padding: "4px 8px", borderRadius: "4px" }}>
                                Clear X
                            </button>
                        </div>

                        <div style={{ fontSize: "16px", fontWeight: "bold", color: "#1e293b", marginBottom: "8px" }}>
                            Account: {parcelMetadata.account_num?.startsWith("UNASSIGNED_") ? "⚠️ Unassigned Right-of-Way / Plot" : parcelMetadata.account_num}
                        </div>

                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px", marginBottom: "12px" }}>
                            <div style={{ background: "white", padding: "8px 12px", borderRadius: "6px", border: "1px solid #e2e8f0" }}>
                                <div style={{ fontSize: "11px", color: "#64748b" }}>Land (LMA)</div>
                                <div style={{ fontSize: "15px", fontWeight: "bold", color: "#0f172a", marginTop: "2px" }}>
                                    {formatValuation(parcelMetadata.lma)}
                                </div>
                            </div>
                            <div style={{ background: "white", padding: "8px 12px", borderRadius: "6px", border: "1px solid #e2e8f0" }}>
                                <div style={{ fontSize: "11px", color: "#64748b" }}>Impr (IMA)</div>
                                <div style={{ fontSize: "15px", fontWeight: "bold", color: "#ea580c", marginTop: "2px" }}>
                                    {formatValuation(parcelMetadata.ima)}
                                </div>
                            </div>
                        </div>

                        <div style={{ fontSize: "12px", color: "#334155", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", background: "#f1f5f9", padding: "10px", borderRadius: "6px", marginBottom: "10px" }}>
                            <div><strong>Tax Year:</strong> {parcelMetadata.appraisal_yr || "2026"}</div>
                            <div><strong>Division:</strong> {parcelMetadata.division_cd || "N/A"}</div>
                            <div style={{ gridColumn: "1 / -1", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}><strong>Business:</strong> {parcelMetadata.biz_name || "None Registered"}</div>
                        </div>

                        {/* ⚖️ POPUP MODAL LAUNCHER ACTION BUTTON (Public Only) */}
                        {!parcelMetadata.account_num?.startsWith("UNASSIGNED_") && userRole === "public" && (
                            <button 
                                onClick={() => { setProtestStatusMsg(""); setShowProtestModal(true); }}
                                style={{ width: "100%", background: "#0284c7", color: "#ffffff", border: "none", padding: "10px", fontSize: "12px", borderRadius: "4px", cursor: "pointer", fontWeight: "bold", marginTop: "8px", boxShadow: "0 2px 4px rgba(2,132,199,0.2)" }}
                            >
                                ⚖️ File Official Valuation Dispute
                            </button>
                        )}
                        
                        {/* 📐 SPATIAL GEOMETRY EDITOR (GIS Editors & Admins Only - Topology Active Only) */}
                        {(() => {
                            const isActiveTopologyIssue = activeTab === "qa_rules" && moduleData.some(issue => issue.account_num === parcelMetadata?.account_num);
                            
                            return parcelMetadata && 
                                   !parcelMetadata.account_num?.startsWith("UNASSIGNED_") && 
                                   ['gis_editor', 'gis_editor_user', 'admin'].includes(userRole) && 
                                   isActiveTopologyIssue && (
                                <div style={{ padding: "20px", background: "#f0fdf4", borderTop: "1px solid #bbf7d0", marginTop: "12px" }}>
                                    <h3 style={{ margin: "0 0 10px 0", fontSize: "12px", color: "#166534", textTransform: "uppercase", fontWeight: "bold" }}>
                                        📐 Geometry Editor Workspace
                                    </h3>
                                    
                                    <div style={{ fontSize: "11px", color: "#15803d", marginBottom: "12px", lineHeight: "1.4" }}>
                                        Entering editor mode allows manual vertex manipulation on the spatial fabric. Changes commit directly to PostGIS.
                                    </div>

                                    <div style={{ display: "flex", gap: "8px" }}>
                                        <button 
                                            onClick={() => {
                                                if (!editorMode) {
                                                    if (globalGraphicsLayer.graphics.length > 0) {
                                                        globalSketchViewModel.update(globalGraphicsLayer.graphics.getItemAt(0));
                                                        setEditorMode(true);
                                                    }
                                                } else {
                                                    globalSketchViewModel.cancel();
                                                    setEditorMode(false);
                                                }
                                            }}
                                            style={{ flex: 1, padding: "8px", background: editorMode ? "#166534" : "#22c55e", color: "white", border: "none", borderRadius: "4px", fontSize: "11px", fontWeight: "bold", cursor: "pointer" }}
                                        >
                                            {editorMode ? "Cancel Editing" : "Enable Drawing Tools ✏️"}
                                        </button>
                                        
                                        {editorMode && (
                                            <button 
                                                disabled={savingGeometry}
                                                onClick={async () => {
                                                    setSavingGeometry(true);
                                                    try {
                                                        globalSketchViewModel.complete();
                                                        
                                                        // Grab Graphic Geometry
                                                        const updatedGraphic = globalGraphicsLayer.graphics.getItemAt(0);
                                                        const esriGeom = updatedGraphic.geometry;

                                                        // 🔄 Convert Esri Polygon format back to standard GeoJSON
                                                        const geoJsonPayload = {
                                                            type: "Polygon",
                                                            coordinates: esriGeom.rings
                                                        };

                                                        // INTEGRATION: Pass explicitly extracted SRID (Defaulting to your DB's 4326)
                                                        const currentSrid = esriGeom.spatialReference?.wkid || 4326;

                                                        const res = await fetch(`http://127.0.0.1:8000/api/parcels/${parcelMetadata.account_num}/update-geometry`, {
                                                            method: "PATCH",
                                                            headers: { 
                                                                "Content-Type": "application/json",
                                                                "Authorization": `Bearer ${authToken}`
                                                            },
                                                            body: JSON.stringify({
                                                            ...geoJsonPayload,
                                                            srid: currentSrid
                                                            })
                                                        });
                                                        if (res.ok) {
                                                            alert("Geometry successfully reshaped and saved to PostGIS!");
                                                            setEditorMode(false);
                                                            
                                                            // --- CHECKLIST MECHANIC ---
                                                            if (activeTab === "qa_rules") {
                                                                const resolvedIssue = moduleData.find(i => i.account_num === parcelMetadata.account_num);
                                                                
                                                                if (resolvedIssue) {
                                                                    fetch(`http://127.0.0.1:8000/api/qa/resolve-issue/${resolvedIssue.issue_id}`, {
                                                                        method: "POST",
                                                                        headers: { "Authorization": `Bearer ${authToken}` }
                                                                    }).catch(err => console.error("Backend auto-resolve failed:", err));
                                                                }

                                                                setModuleData(prevData => prevData.filter(issue => issue.account_num !== parcelMetadata.account_num));
                                                            }
                                                            
                                                            handleClearSelection();
                                                            // --------------------------
                                                        } else {
                                                            const errData = await res.json();
                                                            alert(`Geometry update failed: ${errData.detail}`);
                                                        }
                                                    } catch (err) {
                                                        console.error("Save failure:", err);
                                                        alert("Communication error during save sequence.");
                                                    } finally {
                                                        setSavingGeometry(false);
                                                    }
                                                }}
                                                style={{ flex: 1, padding: "8px", background: "#0f172a", color: "white", border: "none", borderRadius: "4px", fontSize: "11px", fontWeight: "bold", cursor: "pointer" }}
                                            >
                                                {savingGeometry ? "Saving..." : "Save Geometry 💾"}
                                            </button>
                                        )}
                                    </div>
                                </div>
                            );
                        })()}
                    </div>
                )}

            </div>

            {/* INTEGRATION: Fallback styled container preventing layout flex collapse errors to `0px` on component rerender */}
            <div style={{ flex: 1, position: "relative", minHeight: "100%", backgroundColor: "#e2e8f0" }}>
                <div ref={mapContainer} style={{ width: "100%", height: "100%", position: "absolute", top: 0, left: 0 }} />
            </div>

            {/* ⚖️ FLOATING COMPLIANT DISPUTE SUBMISSION MODAL LAYER */}
            {showProtestModal && (
                <div style={{
                    position: "absolute", top: 0, left: 0, width: "100vw", height: "100vh",
                    backgroundColor: "rgba(15, 23, 42, 0.6)", backdropFilter: "blur(4px)",
                    display: "flex", justifyContent: "center", alignItems: "center", zIndex: 1000
                }}>
                    <div style={{
                        background: "#ffffff", width: "480px", borderRadius: "8px", 
                        boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)",
                        overflow: "hidden", border: "1px solid #e2e8f0"
                    }}>
                        {/* Modal Header */}
                        <div style={{ background: "#0f172a", color: "#ffffff", padding: "16px 20px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <h3 style={{ margin: 0, fontSize: "14px", fontWeight: "bold" }}>Formal Real Estate Appraisal Protest Form</h3>
                            <button onClick={() => setShowProtestModal(false)} style={{ background: "transparent", border: "none", color: "#94a3b8", fontSize: "16px", cursor: "pointer" }}>✕</button>
                        </div>

                        {/* Modal Body */}
                        <form onSubmit={handleProtestSubmit} style={{ padding: "20px", display: "flex", flexDirection: "column", gap: "14px" }}>
                            <div style={{ fontSize: "12px", color: "#475569", background: "#f8fafc", padding: "10px", borderRadius: "4px", border: "1px solid #e2e8f0" }}>
                                <div><strong>Target Asset Key:</strong> <span style={{ fontFamily: "monospace" }}>{selectedAccount}</span></div>
                                <div><strong>Current Appraiser Allocation Yr:</strong> 2026</div>
                            </div>

                            <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                                <label style={{ fontSize: "11px", fontWeight: "bold", color: "#334155", textTransform: "uppercase" }}>Reason for Disagreement</label>
                                <textarea 
                                    placeholder="Provide explicit supporting rationale (e.g., structural damage documentation, neighborhood market disparities, square footage calculation clerical errors)..."
                                    value={protestReason}
                                    onChange={(e) => setProtestReason(e.target.value)}
                                    required
                                    style={{ width: "100%", height: "110px", fontSize: "12px", padding: "10px", borderRadius: "4px", border: "1px solid #cbd5e1", boxSizing: "border-box", fontFamily: "inherit", resize: "none" }}
                                />
                            </div>

                            {protestStatusMsg && (
                                <div style={{ fontSize: "12px", padding: "8px 12px", borderRadius: "4px", fontWeight: "600", textAlign: "center", background: protestStatusMsg.includes("✅") ? "#dcfce7" : "#fef2f2", color: protestStatusMsg.includes("✅") ? "#15803d" : "#b91c1c" }}>
                                    {protestStatusMsg}
                                </div>
                            )}

                            {/* Modal Footer Controls */}
                            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", borderTop: "1px solid #e2e8f0", paddingTop: "12px", marginTop: "4px" }}>
                                <button 
                                    type="button" 
                                    onClick={() => setShowProtestModal(false)} 
                                    disabled={submittingProtest}
                                    style={{ padding: "8px 14px", background: "#cbd5e1", color: "#334155", border: "none", borderRadius: "4px", cursor: "pointer", fontSize: "12px", fontWeight: "600" }}
                                >
                                    Cancel
                                </button>
                                <button 
                                    type="submit" 
                                    disabled={submittingProtest || !protestReason.trim()}
                                    style={{ padding: "8px 18px", background: "#0284c7", color: "#ffffff", border: "none", borderRadius: "4px", cursor: (submittingProtest || !protestReason.trim()) ? "not-allowed" : "pointer", fontSize: "12px", fontWeight: "bold", opacity: (!protestReason.trim()) ? 0.6 : 1 }}
                                >
                                    {submittingProtest ? "Transmitting Ledger Record..." : "Submit Formal Dispute"}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

        </div>
    );
}