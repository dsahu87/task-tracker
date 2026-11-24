import { initializeApp } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
import { getFirestore, collection, addDoc, deleteDoc, doc, updateDoc, onSnapshot, query, orderBy, setDoc, writeBatch } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyANyr4gQJH-VcNtLVbzpZZpzbmBk1xkcv4",
  authDomain: "keep-6aafc.firebaseapp.com",
  projectId: "keep-6aafc",
  storageBucket: "keep-6aafc.firebasestorage.app",
  messagingSenderId: "445341993304",
  appId: "1:445341993304:web:9ded5f98bb6b5f8c0b3d2d"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const notesCollection = collection(db, "notes");

const settingsDocRef = doc(db, "notes", "_settings_labelsConfig");
const habitsDocRef = doc(db, "notes", "_settings_habitsConfig");

let notes = [];
let habits = [];
let currentLabelFilter = 'ALL'; 
let currentTrackerLabelFilter = 'ALL'; 

// View Mode: 'TIMELINE', 'LABELLINE', or 'TRACKER'
let currentWorkspaceViewMode = 'LABELLINE';

// Inline Creator State
let isInlineCreatorExpanded = false;
let inlineCreatorPinnedState = false;
let inlineCreatorStrictState = false; 
let selectedInlineCreatorLabels = [];
let inlineCreatorChecklistLines = [];
let inlineCreatorColorState = '#ffffff';

// Inline Tracker Creator State
let isInlineTrackerCreatorExpanded = false;
let inlineTrackerCreatorPinnedState = false;
let inlineTrackerCreatorTypeState = 'boolean';
let selectedInlineTrackerCreatorLabels = [];

let pinnedLabelsRegistry = []; 
let pinnedHabitsRegistry = [];
let pinnedTrackerLabelsRegistry = [];

let isSingleColumnView = true; 
let isHabitsDashboardCollapsed = false; 

// In-Card Editor Active State
let activeInlineEditingNoteId = null;
let inCardLabelsState = [];
let inCardChecklistLines = [];
let inCardStrictState = false;
let inCardPinnedState = false;
let inCardColorState = '#ffffff';

let currentlyExpandedNoteId = null;
const completedListsCollapsedState = {};

let notePendingMoveTargetId = null;

let newHabitSelectedType = 'boolean';
let activeHabitInputContext = null;

// Timeline Collapsed State
const timelineCollapsedState = {
  pinned: true,
  OVERDUE: true,
  SOFT_DEADLINE: true,
  NO_DATE: true
};

// Label Line Collapsed State dictionary
const labelLineCollapsedState = {};

// Tracker Label Line Collapsed State dictionary
const trackerLabelLineCollapsedState = {
  pinned: true
};

/* -------------------------------------------------------------
    UNDO BUFFER & CONTROLLER
------------------------------------------------------------- */
let lastDeletedAction = null;
let undoToastTimeout = null;

function recordDeletedAction(type, data, description) {
  lastDeletedAction = { type, data, description };
  showUndoToast(description);
  updateUndoButtonState();
}

function showUndoToast(msg) {
  const toast = document.getElementById('undo-toast');
  const textEl = document.getElementById('undo-toast-text');
  if (!toast || !textEl) return;

  textEl.innerText = msg || "Item deleted";
  toast.classList.add('visible');

  if (undoToastTimeout) clearTimeout(undoToastTimeout);
  undoToastTimeout = setTimeout(() => {
    hideUndoToast();
  }, 7000);
}

window.hideUndoToast = function() {
  const toast = document.getElementById('undo-toast');
  if (toast) toast.classList.remove('visible');
};

function updateUndoButtonState() {
  const btn = document.getElementById('header-undo-btn');
  if (btn) {
    btn.disabled = !lastDeletedAction;
    btn.title = lastDeletedAction ? `Undo: ${lastDeletedAction.description}` : "Nothing to undo";
  }
}

window.triggerGlobalUndo = async function() {
  if (!lastDeletedAction) return;

  const action = lastDeletedAction;
  lastDeletedAction = null;
  hideUndoToast();
  updateUndoButtonState();

  try {
    if (action.type === 'NOTE') {
      await setDoc(doc(db, "notes", action.data.id), action.data);
    } else if (action.type === 'HABIT') {
      habits.push(action.data.habit);
      if (action.data.isPinned && !pinnedHabitsRegistry.includes(action.data.habit.id)) {
        pinnedHabitsRegistry.push(action.data.habit.id);
      }
      await setDoc(habitsDocRef, { habitsList: habits, pinnedHabits: pinnedHabitsRegistry }, { merge: true });
    } else if (action.type === 'NOTE_TEXT') {
      await updateNoteField(action.data.noteId, { text: action.data.previousText });
    } else if (action.type === 'IN_CARD_LINE') {
      if (activeInlineEditingNoteId === action.data.noteId) {
        inCardChecklistLines.splice(action.data.index, 0, action.data.line);
        renderInCardChecklistUI(action.data.noteId, action.data.index);
      }
    } else if (action.type === 'CREATOR_LINES') {
      inlineCreatorChecklistLines = action.data.lines;
      renderInlineCreatorChecklistUI();
    }
  } catch (err) {
    console.error("Failed to undo deletion: ", err);
    alert("Failed to undo deletion.");
  }
};

function getTodayFormattedYYYYMMDD() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getWeekNumber(d) {
  const date = new Date(d.getTime());
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + 3 - ((date.getDay() + 6) % 7));
  const week1 = new Date(date.getFullYear(), 0, 4);
  return 1 + Math.round(((date.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
}
const currentGlobalWeekNumber = getWeekNumber(new Date());

function linkifyText(text) {
  if (!text) return "";
  const urlRegex = /(https?:\/\/[^\s<]+)/g;
  return text.replace(urlRegex, function(url) {
    return `<a href="${url}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation();">${url}</a>`;
  });
}

function calculateElapsedDays(createdAtTimestamp) {
  if (!createdAtTimestamp) return 0;
  const createdDate = new Date(createdAtTimestamp);
  const now = new Date();
  const dCreated = new Date(createdDate.getFullYear(), createdDate.getMonth(), createdDate.getDate());
  const dNow = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffTime = dNow - dCreated;
  return Math.floor(diffTime / (1000 * 60 * 60 * 24));
}

const q = query(notesCollection, orderBy("createdAt", "desc"));
onSnapshot(q, (snapshot) => {
  notes = [];
  snapshot.forEach((snapshotDoc) => { 
    if (snapshotDoc.id !== "_settings_labelsConfig" && snapshotDoc.id !== "_settings_habitsConfig") {
      notes.push({ id: snapshotDoc.id, ...snapshotDoc.data() }); 
    }
  });
  const loadingEl = document.getElementById('loading');
  if (loadingEl) loadingEl.style.display = 'none';
  
  if (activeInlineEditingNoteId) {
    const stillExists = notes.find(n => n.id === activeInlineEditingNoteId);
    if (!stillExists) activeInlineEditingNoteId = null;
  }
  if (currentlyExpandedNoteId) {
    const stillExists = notes.find(n => n.id === currentlyExpandedNoteId);
    if (!stillExists) currentlyExpandedNoteId = null;
  }
  
  triggerFullUIRender();
});

onSnapshot(settingsDocRef, (docSnap) => {
  try {
    pinnedLabelsRegistry = (docSnap.exists() && docSnap.data() && docSnap.data().pinnedLabels) ? docSnap.data().pinnedLabels : [];
  } catch(e) {
    pinnedLabelsRegistry = [];
  }
  triggerFullUIRender();
});

onSnapshot(habitsDocRef, (docSnap) => {
  try {
    habits = (docSnap.exists() && docSnap.data() && docSnap.data().habitsList) ? docSnap.data().habitsList : [];
    pinnedHabitsRegistry = (docSnap.exists() && docSnap.data() && docSnap.data().pinnedHabits) ? docSnap.data().pinnedHabits : [];
    pinnedTrackerLabelsRegistry = (docSnap.exists() && docSnap.data() && docSnap.data().pinnedTrackerLabels) ? docSnap.data().pinnedTrackerLabels : [];
  } catch(e) {
    habits = [];
    pinnedHabitsRegistry = [];
    pinnedTrackerLabelsRegistry = [];
  }
  renderSidebars();
  if (currentWorkspaceViewMode === 'TRACKER') {
    renderHabitsDashboard();
  }
  updateTopHeaderLabels();
});

function triggerFullUIRender() {
  try {
    renderSidebars();
    renderNotes();
    updateTopHeaderLabels();
    updateUndoButtonState();
  } catch(e) {
    console.error("UI Render Exception Catch: ", e);
  }
}

function updateTopHeaderLabels() {
  const isTracker = currentWorkspaceViewMode === 'TRACKER';
  const labelBtn = document.getElementById('header-label-btn');
  const addTrackerBtn = document.getElementById('header-add-tracker-btn');

  if (addTrackerBtn) {
    addTrackerBtn.style.display = 'none';
  }

  if (labelBtn) {
    let count = 0;
    let displayName = "";

    if (isTracker) {
      if (currentTrackerLabelFilter === 'ALL') {
        count = habits.length;
        displayName = 'All Trackers';
      } else if (currentTrackerLabelFilter === 'NONE') {
        count = habits.filter(h => !h.labels || h.labels.length === 0).length;
        displayName = 'No Label';
      } else {
        count = habits.filter(h => h.labels && h.labels.includes(currentTrackerLabelFilter)).length;
        displayName = currentTrackerLabelFilter;
      }
    } else {
      if (currentLabelFilter === 'ALL') {
        count = notes.length;
        displayName = 'All Notes';
      } else if (currentLabelFilter === 'NONE') {
        count = notes.filter(n => !n.labels || n.labels.length === 0).length;
        displayName = 'No Label';
      } else if (currentLabelFilter === 'NO_DATE') {
        count = notes.filter(n => !n.dueDate).length;
        displayName = 'No Date';
      } else {
        count = notes.filter(n => n.labels && n.labels.includes(currentLabelFilter)).length;
        displayName = currentLabelFilter;
      }
    }
    
    labelBtn.innerHTML = `<span class="header-btn-icon">🏷️</span><span>${displayName}</span><span style="font-weight:700; color:#1a73e8; font-size:10px;">(${count})</span>`;
  }
}

function getUniqueTrackerLabels() {
  const s = new Set();
  habits.forEach(h => {
    if (h.labels) h.labels.forEach(l => s.add(l));
  });
  return s;
}

window.toggleTrackerLabelPin = async function(event, labelName) {
  event.stopPropagation();
  let updatedRegistry = Array.isArray(pinnedTrackerLabelsRegistry) ? [...pinnedTrackerLabelsRegistry] : [];
  if (updatedRegistry.includes(labelName)) {
    updatedRegistry = updatedRegistry.filter(l => l !== labelName);
  } else {
    updatedRegistry.push(labelName);
  }
  pinnedTrackerLabelsRegistry = updatedRegistry;
  renderSidebars();
  if (currentWorkspaceViewMode === 'TRACKER') {
    renderHabitsDashboard();
  }
  await setDoc(habitsDocRef, { pinnedTrackerLabels: updatedRegistry }, { merge: true });
};

window.setTrackerLabelFilter = function(lbl) {
  currentTrackerLabelFilter = lbl;
  renderSidebars();
  if (currentWorkspaceViewMode === 'TRACKER') {
    renderHabitsDashboard();
  }
  updateTopHeaderLabels();
  closeAllSidebars();
};

window.toggleTrackerCardLabelMenu = function(e, habitId) {
  e.stopPropagation();
  document.querySelectorAll('.checkbox-dropdown-menu').forEach(m => {
    if(m.id !== 'tracker-card-menu-' + habitId) m.classList.remove('show');
  });
  const menu = document.getElementById('tracker-card-menu-' + habitId);
  if (menu) {
    const isShowing = menu.classList.toggle('show');
    if (isShowing) {
      renderTrackerCardLabelDropdownList(habitId, '');
      setTimeout(() => {
        const sb = menu.querySelector('.popover-scroll-body');
        if (sb) sb.scrollTop = 0;
        const inputEl = document.getElementById('tracker-card-search-' + habitId);
        if (inputEl) inputEl.focus();
      }, 10);
    }
  }
};

window.handleTrackerCardLabelSearchInput = function(habitId, val) {
  renderTrackerCardLabelDropdownList(habitId, val.trim());
};

function renderTrackerCardLabelDropdownList(habitId, searchTerm = "") {
  const menu = document.getElementById('tracker-card-menu-' + habitId);
  if (!menu) return;
  const scrollBody = menu.querySelector('.popover-scroll-body');
  if (!scrollBody) return;

  const targetHabit = habits.find(h => h.id === habitId);
  const currentHabitLabels = targetHabit && targetHabit.labels ? targetHabit.labels : [];
  const allLabels = Array.from(getUniqueTrackerLabels());

  let html = "";
  let exactMatch = false;

  if (!searchTerm || 'no label'.includes(searchTerm.toLowerCase())) {
    const isChecked = currentHabitLabels.length === 0 ? 'checked' : '';
    html += `
      <label class="checkbox-item" onclick="event.stopPropagation();">
        <input type="checkbox" ${isChecked} onchange="handleTrackerCardLabelToggle('${habitId}', '', this.checked)">
        <span>No Label</span>
      </label>
    `;
  }

  allLabels.forEach(l => {
    if (l.toLowerCase() === searchTerm.toLowerCase()) exactMatch = true;
    if (!searchTerm || l.toLowerCase().includes(searchTerm.toLowerCase())) {
      const isChecked = currentHabitLabels.includes(l) ? 'checked' : '';
      html += `
        <label class="checkbox-item" onclick="event.stopPropagation();">
          <input type="checkbox" value="${l}" ${isChecked} onchange="handleTrackerCardLabelToggle('${habitId}', this.value, this.checked)">
          <span>${l}</span>
        </label>
      `;
    }
  });

  if (searchTerm && !exactMatch) {
    html = `
      <div class="checkbox-item" onclick="event.stopPropagation(); addNewTrackerCardLabel('${habitId}', '${searchTerm.replace(/'/g, "\\'")}')" style="color:#1a73e8; font-weight:600;">
        <span>➕ Create "${searchTerm}"</span>
      </div>
    ` + html;
  }

  if (!html) {
    html = `<div style="font-size:12px; color:#5f6368; padding:6px;">No matching labels</div>`;
  }
  scrollBody.innerHTML = html;
}

window.handleTrackerCardLabelToggle = async function(habitId, labelVal, isChecked) {
  let targetHabit = habits.find(h => h.id === habitId);
  if (!targetHabit) return;

  let currentLabels = targetHabit.labels ? [...targetHabit.labels] : [];

  if (labelVal === '') {
    currentLabels = [];
  } else {
    if (isChecked) {
      if (!currentLabels.includes(labelVal)) currentLabels.push(labelVal);
    } else {
      currentLabels = currentLabels.filter(l => l !== labelVal);
    }
  }

  targetHabit.labels = currentLabels;
  renderTrackerCardLabelDropdownList(habitId, '');
  renderSidebars();
  if (currentWorkspaceViewMode === 'TRACKER') {
    renderHabitsDashboard();
  }
  updateTopHeaderLabels();

  await setDoc(habitsDocRef, { habitsList: habits }, { merge: true });
};

window.addNewTrackerCardLabel = async function(habitId, newLabel) {
  newLabel = newLabel.trim();
  if (!newLabel) return;
  let targetHabit = habits.find(h => h.id === habitId);
  if (!targetHabit) return;

  let currentLabels = targetHabit.labels ? [...targetHabit.labels] : [];
  if (!currentLabels.includes(newLabel)) currentLabels.push(newLabel);

  targetHabit.labels = currentLabels;
  renderTrackerCardLabelDropdownList(habitId, '');
  renderSidebars();
  if (currentWorkspaceViewMode === 'TRACKER') {
    renderHabitsDashboard();
  }
  updateTopHeaderLabels();

  await setDoc(habitsDocRef, { habitsList: habits }, { merge: true });
};

/* TIMELINE / LABELLINE / TRACKER VIEW SWITCHER */
window.toggleNotesViewMode = function() {
  if (currentWorkspaceViewMode === 'LABELLINE') {
    currentWorkspaceViewMode = 'TIMELINE';
  } else {
    currentWorkspaceViewMode = 'LABELLINE';
  }
  updateHeaderViewModeButtons();
  renderNotes();
  updateTopHeaderLabels();
};

window.switchWorkspaceViewMode = function(mode) {
  currentWorkspaceViewMode = mode;
  updateHeaderViewModeButtons();
  renderNotes();
  updateTopHeaderLabels();
};

function updateHeaderViewModeButtons() {
  const notesModeBtn = document.getElementById('header-notes-mode-btn');
  const trkBtn = document.getElementById('header-tracker-btn');

  if (notesModeBtn) {
    const isNotesView = (currentWorkspaceViewMode !== 'TRACKER');
    notesModeBtn.classList.toggle('active-mode', isNotesView);
    notesModeBtn.innerHTML = `<span class="header-btn-icon">🏷️</span>`;
    notesModeBtn.title = "Notes Workspace";
  }

  if (trkBtn) {
    trkBtn.classList.toggle('active-mode', currentWorkspaceViewMode === 'TRACKER');
  }
}

window.toggleWorkspaceLayoutView = function() {
  isSingleColumnView = !isSingleColumnView;
  const btn = document.getElementById('header-view-btn');
  if (btn) {
    if (isSingleColumnView) {
      btn.innerHTML = `<span class="header-btn-icon">📱</span>`;
      btn.title = "Switch to Grid View";
    } else {
      btn.innerHTML = `<span class="header-btn-icon">🧱</span>`;
      btn.title = "Switch to List View";
    }
  }
  renderNotes();
};

window.toggleAllSectionsUnified = function() {
  if (currentWorkspaceViewMode === 'TRACKER') {
    const allTrackerLabels = Array.from(getUniqueTrackerLabels());
    allTrackerLabels.forEach(l => {
      if (trackerLabelLineCollapsedState[l] === undefined) trackerLabelLineCollapsedState[l] = true;
    });
    if (trackerLabelLineCollapsedState['__NO_LABEL__'] === undefined) {
      trackerLabelLineCollapsedState['__NO_LABEL__'] = true;
    }
    const sectionKeys = Object.keys(trackerLabelLineCollapsedState);
    const hasAnyCollapsed = sectionKeys.some(key => trackerLabelLineCollapsedState[key] === true);
    const targetState = !hasAnyCollapsed;
    sectionKeys.forEach(key => {
      trackerLabelLineCollapsedState[key] = targetState;
    });
    renderHabitsDashboard();
    return;
  }

  // Unified Notes View (Timeline + Label Line combined)
  Array.from(getUniqueLabels()).forEach(l => {
    if (labelLineCollapsedState[l] === undefined) labelLineCollapsedState[l] = true;
  });
  if (labelLineCollapsedState['__NO_LABEL__'] === undefined) {
    labelLineCollapsedState['__NO_LABEL__'] = true;
  }

  const timelineKeys = Object.keys(timelineCollapsedState);
  const labelKeys = Object.keys(labelLineCollapsedState);
  const hasAnyCollapsed =
    timelineKeys.some(k => timelineCollapsedState[k] === true) ||
    labelKeys.some(k => labelLineCollapsedState[k] === true);
  const targetState = !hasAnyCollapsed;

  timelineKeys.forEach(k => { timelineCollapsedState[k] = targetState; });
  labelKeys.forEach(k => { labelLineCollapsedState[k] = targetState; });
  renderNotes();
};

window.toggleLabelSidebarDrawer = function(e) {
  if (e) e.stopPropagation();
  const sb = document.getElementById('sidebars-wrapper-el');
  const overlay = document.getElementById('overlay');
  if (!sb) return;

  const isOpen = sb.classList.contains('open');
  if (isOpen) {
    sb.classList.remove('open');
    if (overlay) overlay.style.display = 'none';
  } else {
    sb.classList.add('open');
    if (overlay) overlay.style.display = 'block';
  }
};

window.closeAllSidebars = function() {
  const sb = document.getElementById('sidebars-wrapper-el');
  if (sb) sb.classList.remove('open');
  const overlay = document.getElementById('overlay');
  if (overlay) overlay.style.display = 'none';
};

window.toggleHabitsDashboardCollapse = function() {
  isHabitsDashboardCollapsed = !isHabitsDashboardCollapsed;
  const gridEl = document.getElementById('tracker-grid-content');
  const arrowEl = document.getElementById('tracker-collapse-arrow');
  if (gridEl) {
    if (isHabitsDashboardCollapsed) {
      gridEl.classList.add('collapsed');
      if (arrowEl) arrowEl.innerText = '▶';
    } else {
      gridEl.classList.remove('collapsed');
      if (arrowEl) arrowEl.innerText = '▼';
    }
  }
};

window.toggleTimelineSectionCollapse = function(sectionKey) {
  timelineCollapsedState[sectionKey] = !timelineCollapsedState[sectionKey];
  renderNotes();
};

window.toggleLabelLineSectionCollapse = function(labelKey) {
  if (labelLineCollapsedState[labelKey] === undefined) {
    labelLineCollapsedState[labelKey] = true;
  }
  labelLineCollapsedState[labelKey] = !labelLineCollapsedState[labelKey];
  renderNotes();
};

window.toggleTrackerLabelLineSectionCollapse = function(labelKey) {
  if (trackerLabelLineCollapsedState[labelKey] === undefined) {
    trackerLabelLineCollapsedState[labelKey] = true;
  }
  trackerLabelLineCollapsedState[labelKey] = !trackerLabelLineCollapsedState[labelKey];
  renderHabitsDashboard();
};

window.editTrackerLabelNameGlobal = async function(oldName, newNameRaw) {
  const newName = newNameRaw.trim();
  if (!newName || newName === oldName) return;

  habits.forEach(h => {
    if (h.labels && h.labels.includes(oldName)) {
      h.labels = h.labels.map(x => x === oldName ? newName : x);
    }
  });
  if (pinnedTrackerLabelsRegistry.includes(oldName)) {
    pinnedTrackerLabelsRegistry = pinnedTrackerLabelsRegistry.map(x => x === oldName ? newName : x);
  }
  if (currentTrackerLabelFilter === oldName) {
    currentTrackerLabelFilter = newName;
  }
  renderSidebars();
  if (currentWorkspaceViewMode === 'TRACKER') {
    renderHabitsDashboard();
  }
  updateTopHeaderLabels();
  await setDoc(habitsDocRef, { habitsList: habits, pinnedTrackerLabels: pinnedTrackerLabelsRegistry }, { merge: true });
};

window.deleteTrackerLabelGlobal = async function(labelName) {
  habits.forEach(h => {
    if (h.labels && h.labels.includes(labelName)) {
      h.labels = h.labels.filter(x => x !== labelName);
    }
  });
  pinnedTrackerLabelsRegistry = pinnedTrackerLabelsRegistry.filter(x => x !== labelName);
  if (currentTrackerLabelFilter === labelName) {
    currentTrackerLabelFilter = 'ALL';
  }
  renderSidebars();
  if (currentWorkspaceViewMode === 'TRACKER') {
    renderHabitsDashboard();
  }
  updateTopHeaderLabels();
  await setDoc(habitsDocRef, { habitsList: habits, pinnedTrackerLabels: pinnedTrackerLabelsRegistry }, { merge: true });
};

window.toggleNoteCardExpand = function(event, noteId) {
  if (event) event.stopPropagation();
  if (currentlyExpandedNoteId === noteId) {
    currentlyExpandedNoteId = null;
  } else {
    currentlyExpandedNoteId = noteId;
  }
  renderNotes();
};

window.toggleCompletedTasksCollapse = function(event, key) {
  if (event) event.stopPropagation();
  completedListsCollapsedState[key] = !completedListsCollapsedState[key];
  
  const wrapper = document.getElementById(`completed-items-${key}`);
  const arrow = document.getElementById(`completed-arrow-${key}`);
  if (wrapper) {
    const isExpanded = completedListsCollapsedState[key];
    wrapper.style.display = isExpanded ? 'flex' : 'none';
    if (arrow) arrow.innerText = isExpanded ? '▼' : '▶';
  }
};

function parseLabelsString(labelStr) {
  if (!labelStr) return [];
  return labelStr.split(',').map(l => l.trim()).filter(l => l.length > 0);
}

/* PROMOTE LIST ITEM TO INDEPENDENT NOTE TITLE */
window.convertChecklistItemToNewNote = async function(event, parentNoteId, lineIndex) {
  if (event) event.stopPropagation();
  const parentNote = notes.find(n => n.id === parentNoteId);
  if (!parentNote) return;

  let lines = parseTextToLines(parentNote.text);
  if (!lines[lineIndex]) return;

  const rawItem = lines[lineIndex];
  const cleanedItemTitle = rawItem.replace(/^\[[ xX]\]\s*/, '').trim();
  if (!cleanedItemTitle) return;

  lines.splice(lineIndex, 1);
  const updatedParentText = lines.join('\n');
  parentNote.text = updatedParentText;
  renderNotes();

  const batch = writeBatch(db);

  batch.update(doc(db, "notes", parentNoteId), {
    text: updatedParentText
  });

  const newNoteRef = doc(collection(db, "notes"));
  batch.set(newNoteRef, {
    title: cleanedItemTitle,
    text: "",
    color: parentNote.color || "#ffffff",
    pinned: parentNote.pinned || false,
    isStrict: parentNote.isStrict || false,
    labels: parentNote.labels ? [...parentNote.labels] : [],
    dueDate: parentNote.dueDate || "",
    createdAt: Date.now()
  });

  await batch.commit();
};

/* MOVE NOTE INTO ANOTHER NOTE AS ITEM */
const moveModalCollapsedState = {};

window.toggleMoveModalSection = function(event, sectionKey) {
  if (event) event.stopPropagation();
  const isCurrentlyCollapsed = moveModalCollapsedState[sectionKey] !== false;
  moveModalCollapsedState[sectionKey] = !isCurrentlyCollapsed;
  renderMoveModalList(document.getElementById('move-modal-search-input')?.value || '');
};

window.openMoveNoteTargetPicker = function(event, sourceNoteId) {
  if (event) event.stopPropagation();
  notePendingMoveTargetId = sourceNoteId;

  const sourceNote = notes.find(n => n.id === sourceNoteId);
  if (!sourceNote) return;

  document.querySelectorAll('.dropdown-menu').forEach(m => m.classList.remove('show'));
  document.querySelectorAll('.note-card').forEach(c => c.classList.remove('menu-open'));

  const modal = document.getElementById('move-target-modal');
  const titleEl = document.getElementById('move-modal-source-title');

  titleEl.innerHTML = `
    <div style="margin-bottom:6px;">Move: "${sourceNote.title || 'Untitled'}"</div>
    <input type="text" id="move-modal-search-input" placeholder="🔍 Filter target notes or labels..." 
           style="width:100%; padding:5px 8px; border:1px solid #dadce0; border-radius:4px; font-size:12px; background:#fff; outline:none;"
           oninput="renderMoveModalList(this.value)">
  `;

  renderMoveModalList('');
  modal.style.display = 'flex';
  setTimeout(() => {
    const searchEl = document.getElementById('move-modal-search-input');
    if (searchEl) searchEl.focus();
  }, 20);
};

window.renderMoveModalList = function(searchTerm = '') {
  const listEl = document.getElementById('move-modal-list');
  if (!listEl || !notePendingMoveTargetId) return;

  const query = searchTerm.trim().toLowerCase();
  listEl.innerHTML = '';

  const candidates = notes.filter(n => n.id !== notePendingMoveTargetId);
  if (candidates.length === 0) {
    listEl.innerHTML = `<div style="font-size:12px; color:#5f6368; padding:8px;">No other notes available to merge into.</div>`;
    return;
  }

  const sortCandidates = (arr) => {
    return [...arr].sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      if (!a.dueDate && b.dueDate) return 1;
      if (a.dueDate && !b.dueDate) return -1;
      if (a.dueDate && b.dueDate && a.dueDate !== b.dueDate) return a.dueDate.localeCompare(b.dueDate);
      return (b.createdAt || 0) - (a.createdAt || 0);
    });
  };

  const buildTargetItemDOM = (c) => {
    const item = document.createElement('div');
    item.className = 'move-target-item';
    item.style.marginLeft = '8px';
    item.onclick = () => executeMoveNoteToTarget(notePendingMoveTargetId, c.id);

    const dateStr = c.dueDate ? `📅 ${c.dueDate}` : 'No date';
    const countLines = parseTextToLines(c.text).length;
    const pinPrefix = c.pinned ? '📌 ' : '';

    item.innerHTML = `
      <div class="move-target-item-title">${pinPrefix}${c.title || 'Untitled'}</div>
      <div class="move-target-item-sub">${dateStr} • ${countLines} items/details</div>
    `;
    return item;
  };

  const renderSection = (sectionKey, titleHTML, headerClass, sectionNotes) => {
    const filteredNotes = query
      ? sectionNotes.filter(n =>
          (n.title || '').toLowerCase().includes(query) ||
          (n.labels || []).some(l => l.toLowerCase().includes(query))
        )
      : sectionNotes;

    if (filteredNotes.length === 0) return false;

    const isCollapsed = query ? false : (moveModalCollapsedState[sectionKey] !== false);
    const arrow = isCollapsed ? '▶' : '▼';

    const header = document.createElement('div');
    header.className = `section-title ${headerClass}`;
    header.style.margin = '8px 0 4px 0';
    header.onclick = (e) => toggleMoveModalSection(e, sectionKey);
    header.innerHTML = `
      <span>${titleHTML} <span style="font-size: 9px; margin-left: 2px;">${arrow}</span></span>
      <span>(${filteredNotes.length})</span>
    `;
    listEl.appendChild(header);

    if (!isCollapsed) {
      const itemsWrapper = document.createElement('div');
      itemsWrapper.style.cssText = 'display:flex; flex-direction:column; gap:5px; margin-bottom:6px;';
      sortCandidates(filteredNotes).forEach(n => {
        itemsWrapper.appendChild(buildTargetItemDOM(n));
      });
      listEl.appendChild(itemsWrapper);
    }
    return true;
  };

  let renderedAny = false;

  // 1. Pinned Notes Section (only if pinned candidates exist)
  const pinnedCandidates = candidates.filter(n => n.pinned);
  if (pinnedCandidates.length > 0) {
    if (renderSection('__PINNED__', '📌 PINNED NOTES', 'execute-now-section-title', pinnedCandidates)) {
      renderedAny = true;
    }
  }

  // 2. Pinned Labels followed by Unpinned Labels
  const pinnedRegistry = Array.isArray(pinnedLabelsRegistry) ? pinnedLabelsRegistry : [];
  const candidateLabels = new Set();
  candidates.forEach(n => {
    if (n.labels) n.labels.forEach(l => candidateLabels.add(l));
  });

  const allLabels = Array.from(candidateLabels);
  const pinnedLabels = allLabels.filter(l => pinnedRegistry.includes(l)).sort((a, b) => a.localeCompare(b));
  const unpinnedLabels = allLabels.filter(l => !pinnedRegistry.includes(l)).sort((a, b) => a.localeCompare(b));

  pinnedLabels.forEach(lbl => {
    const matching = candidates.filter(n => n.labels && n.labels.includes(lbl));
    if (renderSection(`LBL_${lbl}`, `📌 🏷️ ${lbl}`, 'label-pinned-section-title', matching)) {
      renderedAny = true;
    }
  });

  unpinnedLabels.forEach(lbl => {
    const matching = candidates.filter(n => n.labels && n.labels.includes(lbl));
    if (renderSection(`LBL_${lbl}`, `🏷️ ${lbl}`, 'macro-section-title', matching)) {
      renderedAny = true;
    }
  });

  // 3. No Label Notes
  const noLabelCandidates = candidates.filter(n => !n.labels || n.labels.length === 0);
  if (noLabelCandidates.length > 0) {
    if (renderSection('__NO_LABEL__', '⚪ NO LABEL', 'macro-section-title', noLabelCandidates)) {
      renderedAny = true;
    }
  }

  if (!renderedAny) {
    listEl.innerHTML = `<div style="font-size:12px; color:#5f6368; padding:8px; font-style:italic;">No matching target notes found.</div>`;
  }
};

window.closeMoveTargetModal = function() {
  const modal = document.getElementById('move-target-modal');
  if (modal) modal.style.display = 'none';
  notePendingMoveTargetId = null;
};

async function executeMoveNoteToTarget(sourceNoteId, targetNoteId) {
  const sourceNote = notes.find(n => n.id === sourceNoteId);
  const targetNote = notes.find(n => n.id === targetNoteId);
  if (!sourceNote || !targetNote) return;

  const newEntryText = (sourceNote.title || '').trim();
  if (!newEntryText) return;

  let targetText = targetNote.text || '';
  let targetLines = parseTextToLines(targetText);
  const isChecklist = targetLines.length > 0 && targetLines.every(l => l.startsWith('[ ] ') || l.startsWith('[x] '));

  let updatedTargetText = "";
  if (isChecklist) {
    targetLines.push(`[ ] ${newEntryText}`);
    updatedTargetText = targetLines.join('\n');
  } else if (targetLines.length > 0) {
    let converted = targetLines.map(l => l.startsWith('[ ] ') || l.startsWith('[x] ') ? l : `[ ] ${l}`);
    converted.push(`[ ] ${newEntryText}`);
    updatedTargetText = converted.join('\n');
  } else {
    updatedTargetText = `[ ] ${newEntryText}`;
  }

  targetNote.text = updatedTargetText;
  notes = notes.filter(n => n.id !== sourceNoteId);
  renderNotes();

  const batch = writeBatch(db);

  batch.update(doc(db, "notes", targetNoteId), {
    text: updatedTargetText
  });

  batch.delete(doc(db, "notes", sourceNoteId));

  await batch.commit();
  closeMoveTargetModal();
}

/* INLINE NOTE CREATOR CONTROLLER */
window.expandInlineCreator = function(event) {
  if (event) event.stopPropagation();
  if (isInlineCreatorExpanded) return;
  isInlineCreatorExpanded = true;
  selectedInlineCreatorLabels = [];
  if (currentLabelFilter !== 'ALL' && currentLabelFilter !== 'NONE' && currentLabelFilter !== 'NO_DATE') {
    selectedInlineCreatorLabels.push(currentLabelFilter);
  }
  renderNotes();
  setTimeout(() => {
    const titleEl = document.getElementById('inline-c-title');
    if (titleEl) titleEl.focus();
  }, 20);
};

window.saveAndCloseInlineCreator = async function(event) {
  if (event) event.stopPropagation();
  if (!isInlineCreatorExpanded) return;

  const titleInput = document.getElementById('inline-c-title');
  const textInput = document.getElementById('inline-c-text');
  const dateInput = document.getElementById('inline-c-date');
  const labelSearchInput = document.getElementById('inline-c-label-search');

  // Auto-add any un-clicked label currently typed in the search box
  if (labelSearchInput) {
    const typedLabel = labelSearchInput.value.trim();
    if (typedLabel && !selectedInlineCreatorLabels.includes(typedLabel)) {
      selectedInlineCreatorLabels.push(typedLabel);
    }
  }

  const title = titleInput ? titleInput.value.trim() : '';
  let text = textInput ? textInput.value.trim() : '';
  const dueDate = dateInput ? dateInput.value : '';

  const checklistContainer = document.getElementById('inline-c-checklist-container');
  if (checklistContainer && checklistContainer.style.display !== 'none') {
    text = inlineCreatorChecklistLines
      .map(l => l.trim())
      .filter(l => l.replace(/^\[[ xX]\]\s*/, '').length > 0)
      .join('\n');
  }

  if (!title && !text) {
    resetInlineCreatorState();
    renderNotes();
    return;
  }

  let integratedLabels = [...selectedInlineCreatorLabels];
  if (currentLabelFilter !== 'ALL' && currentLabelFilter !== 'NONE' && currentLabelFilter !== 'NO_DATE') {
    if (!integratedLabels.includes(currentLabelFilter)) {
      integratedLabels.push(currentLabelFilter);
    }
  }

  // 1. Capture states BEFORE resetting the form
  const pinState = inlineCreatorPinnedState;
  const strictState = inlineCreatorStrictState;
  const colorState = inlineCreatorColorState;
  const finalLabels = [...integratedLabels];

  // 2. Reset form UI
  resetInlineCreatorState();
  renderNotes();

  // 3. Save to Firebase using the captured states
  await addDoc(notesCollection, {
    title,
    text,
    color: colorState,
    pinned: pinState,
    isStrict: strictState,
    labels: finalLabels,
    dueDate: dueDate || "",
    createdAt: Date.now()
  });
};

window.discardInlineCreatorNote = function(event) {
  if (event) {
    event.stopPropagation();
    event.preventDefault();
  }
  const titleInput = document.getElementById('inline-c-title');
  const textInput = document.getElementById('inline-c-text');
  if (titleInput) titleInput.value = '';
  if (textInput) textInput.value = '';
  resetInlineCreatorState();
  renderNotes();
};

function resetInlineCreatorState() {
  isInlineCreatorExpanded = false;
  inlineCreatorPinnedState = false;
  inlineCreatorStrictState = false;
  inlineCreatorColorState = '#ffffff';
  selectedInlineCreatorLabels = [];
  inlineCreatorChecklistLines = [];
}

window.toggleInlineCreatorPin = function(event) {
  if (event) event.stopPropagation();
  inlineCreatorPinnedState = !inlineCreatorPinnedState;
  const b = document.getElementById('inline-c-pin-btn');
  if (b) b.innerText = inlineCreatorPinnedState ? '📌' : '📍';
};

window.toggleInlineCreatorStrict = function(event) {
  if (event) event.stopPropagation();
  inlineCreatorStrictState = !inlineCreatorStrictState;
  const b = document.getElementById('inline-c-strict-btn');
  if (b) {
    if (inlineCreatorStrictState) b.classList.add('active');
    else b.classList.remove('active');
  }
};

window.changeInlineCreatorColor = function(event, colorHex) {
  if (event) event.stopPropagation();
  inlineCreatorColorState = colorHex;
  const box = document.getElementById('inline-creator-box');
  if (box) box.style.backgroundColor = colorHex;
};

window.toggleInlineCreatorNumberedList = function(event) {
  if (event) event.stopPropagation();
  const t = document.getElementById('inline-c-text');
  if (!t) return;
  let lines = t.value.split('\n');
  let isNum = lines.every(l => l.trim().match(/^\d+\.\s*/) || l.trim() === '');
  t.value = isNum ? lines.map(l => cleanFormattingPrefixes(l)).join('\n') : lines.map((l, i) => l.trim()===''?'':`${i+1}. ${cleanFormattingPrefixes(l)}`).join('\n');
  autoScaleTextarea(t);
};

window.toggleInlineCreatorChecklistFormat = function(event) {
  if (event) event.stopPropagation();
  const t = document.getElementById('inline-c-text');
  const checklistContainer = document.getElementById('inline-c-checklist-container');
  if (!t || !checklistContainer) return;

  if (checklistContainer.style.display !== 'none') {
    const plainText = inlineCreatorChecklistLines.map(l => l.replace(/^\[[ xX]\]\s*/, '')).filter(l => l.length > 0).join('\n');
    t.value = plainText;
    t.style.display = 'block';
    checklistContainer.style.display = 'none';
  } else {
    inlineCreatorChecklistLines = parseTextToLines(buildCleanKeepChecklistString(t.value));
    if (inlineCreatorChecklistLines.length === 0) inlineCreatorChecklistLines = ['[ ] '];
    t.style.display = 'none';
    checklistContainer.style.display = 'flex';
    renderInlineCreatorChecklistUI(0);
  }
  autoScaleTextarea(t);
};

window.toggleInlineCreatorCheckboxMenu = function(event) {
  if (event) event.stopPropagation();
  document.querySelectorAll('.checkbox-dropdown-menu').forEach(m => {
    if(m.id !== 'inline-c-checkbox-menu') m.classList.remove('show');
  });
  const menu = document.getElementById('inline-c-checkbox-menu');
  if (menu) {
    const isShowing = menu.classList.toggle('show');
    if (isShowing) {
      renderInlineCreatorLabelsDropdown('');
      setTimeout(() => {
        const inputEl = document.getElementById('inline-c-label-search');
        if (inputEl) inputEl.focus();
      }, 10);
    }
  }
};

function renderInlineCreatorLabelsDropdown(searchTerm = "") {
  const sb = document.getElementById('inline-c-label-scroll');
  if (!sb) return;
  const all = getUniqueLabels();
  let h = "";
  let exactMatch = false;

  all.forEach(l => {
    if (l.toLowerCase() === searchTerm.toLowerCase()) exactMatch = true;
    if (!searchTerm || l.toLowerCase().includes(searchTerm.toLowerCase())) {
      const isChecked = selectedInlineCreatorLabels.includes(l) ? 'checked' : '';
      h += `
        <label class="checkbox-item" onclick="event.stopPropagation();">
          <input type="checkbox" value="${l}" ${isChecked} onchange="handleInlineCreatorLabelToggle(this.value, this.checked)">
          <span>${l}</span>
        </label>
      `;
    }
  });

  if (searchTerm && !exactMatch) {
    h = `
      <div class="checkbox-item" onclick="event.stopPropagation(); addNewInlineCreatorLabel('${searchTerm.replace(/'/g, "\\'")}')" style="color:#1a73e8; font-weight:600;">
        <span>➕ Create "${searchTerm}"</span>
      </div>
    ` + h;
  }

  if (!h) {
    h = `<div style="font-size:12px; color:#5f6368; padding:6px;">No matching labels</div>`;
  }
  sb.innerHTML = h;
}

window.handleInlineCreatorLabelToggle = function(labelVal, isChecked) {
  if (isChecked) {
    if (!selectedInlineCreatorLabels.includes(labelVal)) selectedInlineCreatorLabels.push(labelVal);
  } else {
    selectedInlineCreatorLabels = selectedInlineCreatorLabels.filter(l => l !== labelVal);
  }
  renderInlineCreatorSelectedLabelsBar();
};

window.addNewInlineCreatorLabel = function(labelName) {
  labelName = labelName.trim();
  if (!labelName) return;
  if (!selectedInlineCreatorLabels.includes(labelName)) selectedInlineCreatorLabels.push(labelName);
  renderInlineCreatorSelectedLabelsBar();
  renderInlineCreatorLabelsDropdown('');
};

function renderInlineCreatorSelectedLabelsBar() {
  const container = document.getElementById('inline-c-selected-labels-bar');
  if (!container) return;
  if (selectedInlineCreatorLabels.length === 0) {
    container.innerHTML = '';
    return;
  }
  container.innerHTML = selectedInlineCreatorLabels.map(l => `
    <span class="modal-label-chip">
      🏷️ ${l}
      <span class="modal-label-chip-remove" onclick="removeInlineCreatorLabelChip(event, '${l.replace(/'/g, "\\'")}')">✕</span>
    </span>
  `).join('');
}

window.removeInlineCreatorLabelChip = function(event, lbl) {
  if (event) event.stopPropagation();
  selectedInlineCreatorLabels = selectedInlineCreatorLabels.filter(l => l !== lbl);
  renderInlineCreatorSelectedLabelsBar();
  renderInlineCreatorLabelsDropdown('');
};

function renderInlineCreatorChecklistUI(focusIndex = -1) {
  const container = document.getElementById('inline-c-checklist-container');
  if (!container) return;

  if (inlineCreatorChecklistLines.length === 0) {
    inlineCreatorChecklistLines = ['[ ] '];
  }

  let uncheckedHTML = "";
  let checkedHTML = "";
  let checkedCount = 0;

  inlineCreatorChecklistLines.forEach((line, index) => {
    let isChecked = line.startsWith('[x] ') || line.startsWith('[X] ');
    let cleanedText = line.replace(/^\[[ xX]\]\s*/, '');

    let rowHTML = `
      <div class="editor-checklist-item inline-todo-row" 
           data-index="${index}"
           draggable="true" 
           ondragstart="handleInlineCreatorDragStart(event, ${index})"
           ondragover="handleDragOver(event)"
           ondrop="handleInlineCreatorDrop(event, ${index})"
           ondragend="handleDragEnd(event)">
        <span class="drag-dots-handle" 
              title="Drag or touch & hold to reorder"
              ontouchstart="handleInlineCreatorTouchStart(event, ${index})"
              ontouchmove="handleTouchMoveHandle(event)"
              ontouchend="handleInlineCreatorTouchEnd(event)">⣿</span>
        <input type="checkbox" class="inline-todo-input-check" ${isChecked ? 'checked' : ''} 
               onchange="handleInlineCreatorCheckToggle(${index}, this.checked)">
        <input type="text" id="inline-c-item-input-${index}" value="${cleanedText.replace(/"/g, '&quot;')}" 
               placeholder="List item"
               oninput="handleInlineCreatorItemTextChange(${index}, this.value)"
               onkeydown="handleInlineCreatorItemKeydown(event, ${index})">
        <button class="editor-item-del-btn" title="Remove item" onclick="handleInlineCreatorDeleteLine(${index})">✕</button>
      </div>
    `;

    if (isChecked) {
      checkedCount++;
      checkedHTML += rowHTML;
    } else {
      uncheckedHTML += rowHTML;
    }
  });

  let finalHTML = uncheckedHTML;
  finalHTML += `
    <div class="editor-add-row" onclick="event.stopPropagation(); addInlineCreatorChecklistItem()">
      <span>+</span>
      <span style="font-size:13px;">List item</span>
    </div>
  `;

  if (checkedCount > 0) {
    finalHTML += `
      <div class="completed-divider-bar">
        <span>▼ ${checkedCount} completed ${checkedCount === 1 ? 'item' : 'items'}</span>
      </div>
      ${checkedHTML}
    `;
  }

  container.innerHTML = finalHTML;

  if (focusIndex >= 0) {
    setTimeout(() => {
      const el = document.getElementById(`inline-c-item-input-${focusIndex}`);
      if (el) { el.focus(); el.selectionStart = el.selectionEnd = el.value.length; }
    }, 10);
  }
}

window.addInlineCreatorChecklistItem = function() {
  inlineCreatorChecklistLines.push('[ ] ');
  renderInlineCreatorChecklistUI(inlineCreatorChecklistLines.length - 1);
};

window.handleInlineCreatorCheckToggle = function(idx, isChecked) {
  let line = inlineCreatorChecklistLines[idx];
  let cleaned = line.replace(/^\[[ xX]\]\s*/, '');
  inlineCreatorChecklistLines[idx] = (isChecked ? '[x] ' : '[ ] ') + cleaned;
  renderInlineCreatorChecklistUI();
};

window.handleInlineCreatorItemTextChange = function(idx, newText) {
  let isChecked = inlineCreatorChecklistLines[idx].startsWith('[x] ') || inlineCreatorChecklistLines[idx].startsWith('[X] ');
  inlineCreatorChecklistLines[idx] = (isChecked ? '[x] ' : '[ ] ') + newText;
};

window.handleInlineCreatorItemKeydown = function(e, idx) {
  if (e.key === 'Enter' || e.keyCode === 13) {
    e.preventDefault();
    inlineCreatorChecklistLines.splice(idx + 1, 0, '[ ] ');
    renderInlineCreatorChecklistUI(idx + 1);
  } else if (e.key === 'Backspace' && e.target.value === '') {
    if (inlineCreatorChecklistLines.length > 1) {
      e.preventDefault();
      inlineCreatorChecklistLines.splice(idx, 1);
      renderInlineCreatorChecklistUI(Math.max(0, idx - 1));
    }
  }
};

window.handleInlineCreatorDeleteLine = function(idx) {
  inlineCreatorChecklistLines.splice(idx, 1);
  if (inlineCreatorChecklistLines.length === 0) inlineCreatorChecklistLines = ['[ ] '];
  renderInlineCreatorChecklistUI(Math.max(0, idx - 1));
};

let inlineCreatorDraggedIndex = null;
window.handleInlineCreatorDragStart = function(e, index) {
  e.stopPropagation();
  inlineCreatorDraggedIndex = index;
  e.target.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', index);
};

window.handleInlineCreatorDrop = function(e, targetIndex) {
  if(e) {
    e.preventDefault();
    e.stopPropagation();
  }
  document.querySelectorAll('#inline-c-checklist-container .editor-checklist-item').forEach(r => r.classList.remove('dragging'));
  if (inlineCreatorDraggedIndex === null || inlineCreatorDraggedIndex === targetIndex) return;

  const movedItem = inlineCreatorChecklistLines.splice(inlineCreatorDraggedIndex, 1)[0];
  inlineCreatorChecklistLines.splice(targetIndex, 0, movedItem);
  inlineCreatorDraggedIndex = null;

  renderInlineCreatorChecklistUI();
};

let inlineCreatorTouchStartData = null;
window.handleInlineCreatorTouchStart = function(e, index) {
  e.stopPropagation();
  const touch = e.touches[0];
  const row = e.target.closest('.editor-checklist-item');
  if(row) row.classList.add('dragging');

  inlineCreatorTouchStartData = {
    index,
    element: row,
    startY: touch.clientY
  };
};

window.handleInlineCreatorTouchEnd = function(e) {
  if (!inlineCreatorTouchStartData) return;
  if(e) e.stopPropagation();

  if(inlineCreatorTouchStartData.element) {
    inlineCreatorTouchStartData.element.classList.remove('dragging');
  }

  const fromIdx = inlineCreatorTouchStartData.index;
  const toIdx = inlineCreatorTouchStartData.currentTargetIndex;
  inlineCreatorTouchStartData = null;

  if (toIdx !== undefined && fromIdx !== toIdx) {
    const movedItem = inlineCreatorChecklistLines.splice(fromIdx, 1)[0];
    inlineCreatorChecklistLines.splice(toIdx, 0, movedItem);
    renderInlineCreatorChecklistUI();
  }
};

window.uncheckAllInlineCreatorItems = function(event) {
  if (event) event.stopPropagation();
  const checklistContainer = document.getElementById('inline-c-checklist-container');
  const textEl = document.getElementById('inline-c-text');

  if (checklistContainer && checklistContainer.style.display !== 'none') {
    inlineCreatorChecklistLines = inlineCreatorChecklistLines.map(l => {
      if (l.startsWith('[x] ') || l.startsWith('[X] ')) return '[ ] ' + l.substring(4);
      return l;
    });
    renderInlineCreatorChecklistUI();
  } else if (textEl) {
    let lines = parseTextToLines(textEl.value);
    let unchk = lines.map(l => {
      if (l.startsWith('[x] ') || l.startsWith('[X] ')) return '[ ] ' + l.substring(4);
      return l;
    });
    textEl.value = unchk.join('\n');
  }
};

window.deleteCheckedInlineCreatorItems = function(event) {
  if (event) event.stopPropagation();
  const checklistContainer = document.getElementById('inline-c-checklist-container');
  const textEl = document.getElementById('inline-c-text');

  if (checklistContainer && checklistContainer.style.display !== 'none') {
    const prev = [...inlineCreatorChecklistLines];
    inlineCreatorChecklistLines = inlineCreatorChecklistLines.filter(l => !l.startsWith('[x] ') && !l.startsWith('[X] '));
    recordDeletedAction('CREATOR_LINES', { lines: prev }, "Checked items deleted");
    renderInlineCreatorChecklistUI();
  } else if (textEl) {
    let lines = parseTextToLines(textEl.value);
    let remaining = lines.filter(l => !l.startsWith('[x] ') && !l.startsWith('[X] '));
    textEl.value = remaining.join('\n');
  }
};

/* OPTIMISTIC FIELD UPDATER: UPDATES MEMORY & REDRAWS DOM IMMEDIATELY */
async function updateNoteField(id, updatedFields) {
  const target = notes.find(n => n.id === id);
  if (target) {
    Object.assign(target, updatedFields);
    renderNotes();
    updateTopHeaderLabels();
  }
  await updateDoc(doc(db, "notes", id), updatedFields);
}

window.autoScaleTextarea = function(element) {
  element.style.height = 'auto';
  element.style.height = element.scrollHeight + 'px';
};
/* INLINE TRACKER TASK CREATOR CONTROLLER */
window.expandInlineTrackerCreator = function(event) {
  if (event) event.stopPropagation();
  if (isInlineTrackerCreatorExpanded) return;
  isInlineTrackerCreatorExpanded = true;
  selectedInlineTrackerCreatorLabels = [];
  if (currentTrackerLabelFilter !== 'ALL' && currentTrackerLabelFilter !== 'NONE') {
    selectedInlineTrackerCreatorLabels.push(currentTrackerLabelFilter);
  }
  renderNotes();
  setTimeout(() => {
    const titleEl = document.getElementById('inline-trk-title');
    if (titleEl) titleEl.focus();
  }, 20);
};

window.saveAndCloseInlineTrackerCreator = async function(event) {
  if (event) event.stopPropagation();
  if (!isInlineTrackerCreatorExpanded) return;

  const titleInput = document.getElementById('inline-trk-title');
  const minRuleInput = document.getElementById('inline-trk-minrule');
  const labelSearchInput = document.getElementById('inline-trk-label-search');

  if (labelSearchInput) {
    const typedLabel = labelSearchInput.value.trim();
    if (typedLabel && !selectedInlineTrackerCreatorLabels.includes(typedLabel)) {
      selectedInlineTrackerCreatorLabels.push(typedLabel);
    }
  }

  const name = titleInput ? titleInput.value.trim() : '';
  const minRuleText = minRuleInput ? minRuleInput.value.trim() : '';

  if (!name) {
    resetInlineTrackerCreatorState();
    renderNotes();
    return;
  }

  let integratedLabels = [...selectedInlineTrackerCreatorLabels];
  if (currentTrackerLabelFilter !== 'ALL' && currentTrackerLabelFilter !== 'NONE') {
    if (!integratedLabels.includes(currentTrackerLabelFilter)) {
      integratedLabels.push(currentTrackerLabelFilter);
    }
  }

  const pinState = inlineTrackerCreatorPinnedState;
  const typeState = inlineTrackerCreatorTypeState;
  const finalLabels = [...integratedLabels];

  resetInlineTrackerCreatorState();

  const uniqueId = 'hbt_' + Date.now();
  const newHabitObj = {
    id: uniqueId,
    name: name,
    habitType: typeState,
    minRuleText: minRuleText,
    labels: finalLabels,
    yearlyGrid: {}
  };
  newHabitObj.yearlyGrid["W" + currentGlobalWeekNumber] = { M: null, T: null, W: null, Th: null, F: null, Sa: null, Su: null };

  habits.push(newHabitObj);
  if (pinState) {
    if (!pinnedHabitsRegistry.includes(uniqueId)) pinnedHabitsRegistry.push(uniqueId);
  }

  renderSidebars();
  renderNotes();
  updateTopHeaderLabels();

  await setDoc(habitsDocRef, { habitsList: habits, pinnedHabits: pinnedHabitsRegistry }, { merge: true });
};

window.discardInlineTrackerCreator = function(event) {
  if (event) {
    event.stopPropagation();
    event.preventDefault();
  }
  resetInlineTrackerCreatorState();
  renderNotes();
};

function resetInlineTrackerCreatorState() {
  isInlineTrackerCreatorExpanded = false;
  inlineTrackerCreatorPinnedState = false;
  inlineTrackerCreatorTypeState = 'boolean';
  selectedInlineTrackerCreatorLabels = [];
}

window.toggleInlineTrackerCreatorPin = function(event) {
  if (event) event.stopPropagation();
  inlineTrackerCreatorPinnedState = !inlineTrackerCreatorPinnedState;
  const b = document.getElementById('inline-trk-pin-btn');
  if (b) b.innerText = inlineTrackerCreatorPinnedState ? '📌' : '📍';
};

window.setInlineTrackerCreatorType = function(event, type) {
  if (event) event.stopPropagation();
  inlineTrackerCreatorTypeState = type;
  document.querySelectorAll('.inline-trk-type-btn').forEach(btn => {
    if (btn.dataset.type === type) {
      btn.style.background = '#e8f0fe';
      btn.style.borderColor = '#1a73e8';
      btn.style.color = '#1a73e8';
    } else {
      btn.style.background = '#fff';
      btn.style.borderColor = '#dadce0';
      btn.style.color = '#5f6368';
    }
  });
};

window.toggleInlineTrackerCreatorCheckboxMenu = function(event) {
  if (event) event.stopPropagation();
  document.querySelectorAll('.checkbox-dropdown-menu').forEach(m => {
    if (m.id !== 'inline-trk-checkbox-menu') m.classList.remove('show');
  });
  const menu = document.getElementById('inline-trk-checkbox-menu');
  if (menu) {
    const isShowing = menu.classList.toggle('show');
    if (isShowing) {
      renderInlineTrackerCreatorLabelsDropdown('');
      setTimeout(() => {
        const inputEl = document.getElementById('inline-trk-label-search');
        if (inputEl) inputEl.focus();
      }, 10);
    }
  }
};

function renderInlineTrackerCreatorLabelsDropdown(searchTerm = "") {
  const sb = document.getElementById('inline-trk-label-scroll');
  if (!sb) return;
  const all = getUniqueTrackerLabels();
  let h = "";
  let exactMatch = false;

  all.forEach(l => {
    if (l.toLowerCase() === searchTerm.toLowerCase()) exactMatch = true;
    if (!searchTerm || l.toLowerCase().includes(searchTerm.toLowerCase())) {
      const isChecked = selectedInlineTrackerCreatorLabels.includes(l) ? 'checked' : '';
      h += `
        <label class="checkbox-item" onclick="event.stopPropagation();">
          <input type="checkbox" value="${l}" ${isChecked} onchange="handleInlineTrackerCreatorLabelToggle(this.value, this.checked)">
          <span>${l}</span>
        </label>
      `;
    }
  });

  if (searchTerm && !exactMatch) {
    h = `
      <div class="checkbox-item" onclick="event.stopPropagation(); addNewInlineTrackerCreatorLabel('${searchTerm.replace(/'/g, "\\'")}')" style="color:#1a73e8; font-weight:600;">
        <span>➕ Create "${searchTerm}"</span>
      </div>
    ` + h;
  }

  if (!h) {
    h = `<div style="font-size:12px; color:#5f6368; padding:6px;">No matching labels</div>`;
  }
  sb.innerHTML = h;
}

window.handleInlineTrackerCreatorLabelToggle = function(labelVal, isChecked) {
  if (isChecked) {
    if (!selectedInlineTrackerCreatorLabels.includes(labelVal)) selectedInlineTrackerCreatorLabels.push(labelVal);
  } else {
    selectedInlineTrackerCreatorLabels = selectedInlineTrackerCreatorLabels.filter(l => l !== labelVal);
  }
  renderInlineTrackerCreatorSelectedLabelsBar();
};

window.addNewInlineTrackerCreatorLabel = function(labelName) {
  labelName = labelName.trim();
  if (!labelName) return;
  if (!selectedInlineTrackerCreatorLabels.includes(labelName)) selectedInlineTrackerCreatorLabels.push(labelName);
  renderInlineTrackerCreatorSelectedLabelsBar();
  renderInlineTrackerCreatorLabelsDropdown('');
};

function renderInlineTrackerCreatorSelectedLabelsBar() {
  const container = document.getElementById('inline-trk-selected-labels-bar');
  if (!container) return;
  if (selectedInlineTrackerCreatorLabels.length === 0) {
    container.innerHTML = '';
    return;
  }
  container.innerHTML = selectedInlineTrackerCreatorLabels.map(l => `
    <span class="modal-label-chip">
      🏷️ ${l}
      <span class="modal-label-chip-remove" onclick="removeInlineTrackerCreatorLabelChip(event, '${l.replace(/'/g, "\\'")}')">✕</span>
    </span>
  `).join('');
}

window.removeInlineTrackerCreatorLabelChip = function(event, lbl) {
  if (event) event.stopPropagation();
  selectedInlineTrackerCreatorLabels = selectedInlineTrackerCreatorLabels.filter(l => l !== lbl);
  renderInlineTrackerCreatorSelectedLabelsBar();
  renderInlineTrackerCreatorLabelsDropdown('');
};

let trackerModalSelectedType = 'boolean';

window.openTrackerCreatorModal = function(event) {
  if(event) event.stopPropagation();
  document.getElementById('tracker-creator-name').value = '';
  document.getElementById('tracker-creator-minrule').value = '';
  trackerModalSelectedType = 'boolean';
  document.getElementById('tracker-creator-pin-check').checked = false;
  updateTrackerCreatorTypeUI('boolean');
  document.getElementById('tracker-creator-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('tracker-creator-name').focus(), 50);
};

window.closeTrackerCreatorModal = function() {
  document.getElementById('tracker-creator-modal').style.display = 'none';
};

window.setTrackerModalType = function(type) {
  trackerModalSelectedType = type;
  updateTrackerCreatorTypeUI(type);
};

function updateTrackerCreatorTypeUI(type) {
  document.querySelectorAll('.tracker-type-pill').forEach(pill => {
    if(pill.dataset.type === type) pill.classList.add('active');
    else pill.classList.remove('active');
  });
}

window.submitTrackerCreatorModal = async function() {
  const nameInput = document.getElementById('tracker-creator-name');
  const minRuleInput = document.getElementById('tracker-creator-minrule');
  const name = nameInput.value.trim();
  if(!name) {
    alert("Please enter a task tracker name.");
    nameInput.focus();
    return;
  }

  const minRuleText = minRuleInput.value.trim();
  const isPinned = document.getElementById('tracker-creator-pin-check').checked;

  const uniqueId = 'hbt_' + Date.now();
  const newHabitObj = { 
    id: uniqueId, 
    name: name, 
    habitType: trackerModalSelectedType, 
    minRuleText: minRuleText, 
    labels: currentTrackerLabelFilter !== 'ALL' && currentTrackerLabelFilter !== 'NONE' ? [currentTrackerLabelFilter] : [],
    yearlyGrid: {} 
  };
  newHabitObj.yearlyGrid["W" + currentGlobalWeekNumber] = { M: null, T: null, W: null, Th: null, F: null, Sa: null, Su: null };
  
  habits.push(newHabitObj);
  if(isPinned) {
    if(!pinnedHabitsRegistry.includes(uniqueId)) pinnedHabitsRegistry.push(uniqueId);
  } else {
    pinnedHabitsRegistry = pinnedHabitsRegistry.filter(id => id !== uniqueId);
  }

  renderSidebars();
  if (currentWorkspaceViewMode === 'TRACKER') {
    renderHabitsDashboard();
  }
  updateTopHeaderLabels();
  closeTrackerCreatorModal();

  await setDoc(habitsDocRef, { habitsList: habits, pinnedHabits: pinnedHabitsRegistry }, { merge: true });
};

window.handleHabitDayClick = function(event, habitId, dayKey, habitType) {
  event.stopPropagation();
  const weekKey = "W" + currentGlobalWeekNumber;
  let targetHabit = habits.find(h => h.id === habitId);
  if(!targetHabit) return;
  
  let weekHistory = (targetHabit.yearlyGrid && targetHabit.yearlyGrid[weekKey]) ? {...targetHabit.yearlyGrid[weekKey]} : { M: null, T: null, W: null, Th: null, F: null, Sa: null, Su: null };
  let currentVal = weekHistory[dayKey];

  if (habitType === 'boolean') {
    let isDone = currentVal !== null && currentVal !== undefined && currentVal !== false && currentVal !== '';
    let newValue = !isDone;
    weekHistory[dayKey] = newValue;
    saveHabitWeekHistory(habitId, weekKey, weekHistory);
  } else {
    activeHabitInputContext = { habitId, weekKey, dayKey, habitType, weekHistory, currentVal };
    const modal = document.getElementById('habit-input-modal');
    const titleEl = document.getElementById('habit-modal-title');
    const inputEl = document.getElementById('habit-modal-input');
    
    if (habitType === 'count') {
      titleEl.innerText = "Enter numeric count:";
      inputEl.type = "number";
      inputEl.placeholder = "e.g. 3";
      inputEl.value = (currentVal !== null && currentVal !== undefined && currentVal !== '') ? currentVal : '';
    } else {
      titleEl.innerText = "Enter details (e.g. Dr. X):";
      inputEl.type = "text";
      inputEl.placeholder = "e.g. Dr. X";
      inputEl.value = (currentVal !== null && currentVal !== undefined && currentVal !== '') ? currentVal : '';
    }
    
    modal.style.display = 'flex';
    setTimeout(() => inputEl.focus(), 50);
  }
};

window.submitHabitModalInput = async function() {
  if (!activeHabitInputContext) return;
  const inputEl = document.getElementById('habit-modal-input');
  const val = inputEl.value.trim();
  const { habitId, weekKey, dayKey, habitType, weekHistory } = activeHabitInputContext;

  let newValue = null;
  if (val !== '') {
    if (habitType === 'count') {
      let num = parseFloat(val);
      newValue = isNaN(num) ? null : num;
    } else {
      newValue = val;
    }
  }

  weekHistory[dayKey] = newValue;
  await saveHabitWeekHistory(habitId, weekKey, weekHistory);
  closeHabitModalInput();
};

window.closeHabitModalInput = function() {
  const modal = document.getElementById('habit-input-modal');
  if (modal) modal.style.display = 'none';
  activeHabitInputContext = null;
};

async function saveHabitWeekHistory(habitId, weekKey, weekHistory) {
  const target = habits.find(h => h.id === habitId);
  if (target) {
    if (!target.yearlyGrid) target.yearlyGrid = {};
    target.yearlyGrid[weekKey] = weekHistory;
    if (currentWorkspaceViewMode === 'TRACKER') {
      renderHabitsDashboard();
    }
  }
  await setDoc(habitsDocRef, { habitsList: habits }, { merge: true });
}

window.toggleHabitPin = async function(event, habitId) {
  event.stopPropagation();
  let updatedRegistry = Array.isArray(pinnedHabitsRegistry) ? [...pinnedHabitsRegistry] : [];
  if(updatedRegistry.includes(habitId)) updatedRegistry = updatedRegistry.filter(id => id !== habitId);
  else updatedRegistry.push(habitId);
  pinnedHabitsRegistry = updatedRegistry;
  if (currentWorkspaceViewMode === 'TRACKER') {
    renderHabitsDashboard();
  }
  await setDoc(habitsDocRef, { pinnedHabits: updatedRegistry }, { merge: true });
};

window.editHabitNameGlobal = async function(habitId, newNameRaw) {
  const name = newNameRaw.trim();
  if(!name) return;
  const target = habits.find(h => h.id === habitId);
  if (target) target.name = name;
  if (currentWorkspaceViewMode === 'TRACKER') {
    renderHabitsDashboard();
  }
  await setDoc(habitsDocRef, { habitsList: habits }, { merge: true });
};

window.editHabitMinRuleGlobal = async function(habitId, minRuleRaw) {
  const target = habits.find(h => h.id === habitId);
  if (target) target.minRuleText = minRuleRaw.trim();
  if (currentWorkspaceViewMode === 'TRACKER') {
    renderHabitsDashboard();
  }
  await setDoc(habitsDocRef, { habitsList: habits }, { merge: true });
};

window.deleteHabitGlobal = async function(habitId) {
  const deletedHabit = habits.find(h => h.id === habitId);
  const isPinned = (Array.isArray(pinnedHabitsRegistry) ? pinnedHabitsRegistry : []).includes(habitId);

  if (deletedHabit) {
    recordDeletedAction('HABIT', { habit: deletedHabit, isPinned }, `Tracker "${deletedHabit.name || 'Task'}" deleted`);
  }

  habits = habits.filter(h => h.id !== habitId);
  pinnedHabitsRegistry = (Array.isArray(pinnedHabitsRegistry) ? pinnedHabitsRegistry : []).filter(id => id !== habitId);
  renderSidebars();
  if (currentWorkspaceViewMode === 'TRACKER') {
    renderHabitsDashboard();
  }
  updateTopHeaderLabels();
  await setDoc(habitsDocRef, { habitsList: habits, pinnedHabits: pinnedHabitsRegistry }, { merge: true });
};

let currentAnalyticsHabitRef = null;
let selectedActiveWeekKey = null;

window.openHabitAnalyticsMatrix = function(event, habitId) {
  event.stopPropagation();
  const targetHabit = habits.find(h => h.id === habitId);
  if(!targetHabit) return;

  currentAnalyticsHabitRef = targetHabit;
  closeAllSidebars();

  document.getElementById('matrix-title-label').innerText = `Annual Performance: ${targetHabit.name}`;
  const container = document.getElementById('matrix-grid-target');
  container.innerHTML = "";
  
  const inspector = document.getElementById('week-logs-inspector');
  if (inspector) inspector.style.display = 'none';
  
  let htmlGridStr = "";
  const gridData = targetHabit.yearlyGrid || {};
  const hType = targetHabit.habitType || 'boolean';
  
  for(let w = 1; w <= 52; w++) {
    const wKey = "W" + w;
    const daysCheckedBlock = gridData[wKey] || {};
    
    let checkedCount = 0;
    let cumulativeCount = 0;
    
    Object.keys(daysCheckedBlock).forEach(d => {
      if (d !== 'retroNote') {
        let val = daysCheckedBlock[d];
        if (val !== null && val !== undefined && val !== false && val !== '') {
          checkedCount++;
          if (hType === 'count' && typeof val === 'number') {
            cumulativeCount += val;
          } else if (hType === 'count' && !isNaN(parseFloat(val))) {
            cumulativeCount += parseFloat(val);
          }
        }
      }
    });
    
    let colorClass = "score-none";
    let activeOutlineStyle = (w === currentGlobalWeekNumber) ? "border: 2px solid #1a73e8; font-weight: bold;" : "";
    
    if (hType === 'count') {
      if (cumulativeCount > 0 && cumulativeCount <= 2) colorClass = "score-low";
      else if (cumulativeCount >= 3 && cumulativeCount <= 6) colorClass = "score-mid";
      else if (cumulativeCount >= 7) colorClass = "score-high";
      
      let displayScore = cumulativeCount > 0 ? `#${cumulativeCount}` : '0d';
      htmlGridStr += `<div class="matrix-cell ${colorClass}" style="${activeOutlineStyle}" onclick="inspectWeekLogs('${wKey}')" title="Week ${w}"><span class="matrix-cell-week-num">W${w}</span><span class="matrix-cell-score">${displayScore}</span></div>`;
    } else if (hType === 'log') {
      if (checkedCount > 0 && checkedCount <= 2) colorClass = "score-low";
      else if (checkedCount >= 3 && checkedCount <= 4) colorClass = "score-mid";
      else if (checkedCount >= 5) colorClass = "score-high";
      
      let displayScore = checkedCount > 0 ? `${checkedCount} logs` : '0d';
      htmlGridStr += `<div class="matrix-cell ${colorClass}" style="${activeOutlineStyle}" onclick="inspectWeekLogs('${wKey}')" title="Week ${w}"><span class="matrix-cell-week-num">W${w}</span><span class="matrix-cell-score">${displayScore}</span></div>`;
    } else {
      if(checkedCount > 0 && checkedCount <= 2) colorClass = "score-low";
      else if(checkedCount >= 3 && checkedCount <= 4) colorClass = "score-mid";
      else if(checkedCount >= 5) colorClass = "score-high";
      
      htmlGridStr += `<div class="matrix-cell ${colorClass}" style="${activeOutlineStyle}" onclick="inspectWeekLogs('${wKey}')" title="Week ${w}"><span class="matrix-cell-week-num">W${w}</span><span class="matrix-cell-score">${checkedCount}d</span></div>`;
    }
  }

  container.innerHTML = htmlGridStr;
  document.getElementById('matrix-backdrop-panel').style.display = 'flex';
};

window.inspectWeekLogs = function(weekKey) {
  if (!currentAnalyticsHabitRef) return;
  selectedActiveWeekKey = weekKey;
  const gridData = currentAnalyticsHabitRef.yearlyGrid || {};
  const weekBlock = gridData[weekKey] || {};
  const inspector = document.getElementById('week-logs-inspector');
  const listTarget = document.getElementById('week-logs-list-target');
  const titleTarget = document.getElementById('inspector-week-title');
  const retroInput = document.getElementById('week-retro-input');

  titleTarget.innerText = `Detailed Entries for Week ${weekKey.substring(1)}`;
  
  let itemsHTML = "";
  const daysOrder = ['M', 'T', 'W', 'Th', 'F', 'Sa', 'Su'];
  
  daysOrder.forEach(day => {
    let val = weekBlock[day];
    if (val !== null && val !== undefined && val !== false && val !== '') {
      itemsHTML += `
        <div class="week-inspector-item">
          <strong style="color:#1a73e8;">Day (${day}):</strong>
          <span style="color:#202124; font-weight:600;">${val}</span>
        </div>
      `;
    }
  });

  if (!itemsHTML) {
    itemsHTML = `<div style="font-size:12px; color:#757575; font-style:italic; text-align:center; padding:4px;">No daily logs for this week.</div>`;
  }

  listTarget.innerHTML = itemsHTML;
  retroInput.value = weekBlock.retroNote || '';
  inspector.style.display = 'flex';
};

window.saveWeeklyRetrospective = async function() {
  if (!currentAnalyticsHabitRef || !selectedActiveWeekKey) return;
  const retroText = document.getElementById('week-retro-input').value.trim();
  const habitId = currentAnalyticsHabitRef.id;
  const weekKey = selectedActiveWeekKey;

  let gridData = currentAnalyticsHabitRef.yearlyGrid || {};
  if (!gridData[weekKey]) gridData[weekKey] = {};
  gridData[weekKey].retroNote = retroText;

  const updatedHabits = habits.map(h => {
    if (h.id === habitId) {
      h.yearlyGrid = gridData;
    }
    return h;
  });

  await setDoc(habitsDocRef, { habitsList: updatedHabits }, { merge: true });
  alert("Weekly retrospective note saved successfully!");
};

window.closeMatrixModal = function() {
  document.getElementById('matrix-backdrop-panel').style.display = 'none';
  currentAnalyticsHabitRef = null;
  selectedActiveWeekKey = null;
};

function renderHabitsDashboard() {
  const targetPanel = document.getElementById('habits-dashboard-target');
  if(!targetPanel) return;
  
  const todayKey = ['Su', 'M', 'T', 'W', 'Th', 'F', 'Sa'][new Date().getDay()];
  const currentWeekKey = "W" + currentGlobalWeekNumber;

  let filteredHabits = habits;
  if (currentTrackerLabelFilter === 'NONE') {
    filteredHabits = habits.filter(h => !h.labels || h.labels.length === 0);
  } else if (currentTrackerLabelFilter !== 'ALL') {
    filteredHabits = habits.filter(h => h.labels && h.labels.includes(currentTrackerLabelFilter));
  }

  const pinnedRegistry = Array.isArray(pinnedHabitsRegistry) ? pinnedHabitsRegistry : [];
  const pinnedHabits = filteredHabits.filter(h => pinnedRegistry.includes(h.id));
  const regularHabits = filteredHabits;

  const sortHabitsGroup = (habitList) => {
    return [...habitList].sort((a,b) => {
      const aPinned = pinnedRegistry.includes(a.id);
      const bPinned = pinnedRegistry.includes(b.id);
      if (aPinned !== bPinned) return aPinned ? -1 : 1;
      const aCount = calculateWeeklyCompletedCount(a.yearlyGrid, currentWeekKey);
      const bCount = calculateWeeklyCompletedCount(b.yearlyGrid, currentWeekKey);
      if (aCount !== bCount) return aCount - bCount;
      return (a.name || '').localeCompare(b.name || '');
    });
  };

  const daysOfWeek = ['M', 'T', 'W', 'Th', 'F', 'Sa', 'Su'];

  const renderSingleHabitCard = (h, isExecuteNow) => {
    const isPinned = pinnedRegistry.includes(h.id);
    const pinIcon = isPinned ? '📌' : '📍';
    const currentWeekHistory = (h.yearlyGrid && h.yearlyGrid[currentWeekKey]) ? h.yearlyGrid[currentWeekKey] : {};
    const hType = h.habitType || 'boolean';
    const completedDays = calculateWeeklyCompletedCount(h.yearlyGrid, currentWeekKey);

    let bgClass = "habit-card-red";
    if (completedDays === 7) bgClass = "habit-card-green";
    else if (completedDays >= 4 && completedDays <= 6) bgClass = "habit-card-blue";
    else if (completedDays >= 1 && completedDays <= 3) bgClass = "habit-card-yellow";

    let habitLabelsArray = h.labels || [];
    let habitLabelChips = habitLabelsArray.map(l => `<span style="font-size:10px; color:#1a73e8; background:#e8f0fe; padding:1px 5px; border-radius:4px; border:1px solid #d2e3fc;">🏷️ ${l}</span>`).join('');

    const safeName = (h.name || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const safeMinRule = (h.minRuleText || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    let cardHTML = `
      <div class="sidebar-item ${isExecuteNow ? 'execute-now-item' : bgClass}" style="flex-direction: column; align-items: flex-start; gap: 4px; padding: 6px 8px; margin-bottom: 0; border: 1px solid #e0e0e0;">
        <div style="display:flex; width:100%; align-items:center; gap:6px;">
          <span class="sidebar-pin-toggle" onclick="toggleHabitPin(event, '${h.id}')" title="${isPinned ? 'Unpin' : 'Pin to Execute Now'}">${pinIcon}</span>
          
          <div style="position:relative; display:inline-flex;">
            <button class="icon-picker-btn" onclick="toggleTrackerCardLabelMenu(event, '${h.id}')" title="Assign / Change Tracker Label" style="height:22px; padding:0 4px; font-size:10px;">🏷️</button>
            <div class="checkbox-dropdown-menu" id="tracker-card-menu-${h.id}" onclick="event.stopPropagation();">
              <div class="popover-header-fixed">
                <div class="popover-section-title">Label tracker task</div>
                <div class="popover-input-wrapper">
                  <input type="text" id="tracker-card-search-${h.id}" class="label-input" placeholder="Enter label name" oninput="handleTrackerCardLabelSearchInput('${h.id}', this.value)">
                  <span class="search-icon">🔍</span>
                </div>
              </div>
              <div class="popover-scroll-body"></div>
            </div>
          </div>

          ${habitLabelChips}
          <span style="font-weight:600; font-size:12px; flex-grow:1; word-break:break-all;">${h.name || ''}</span>
          <span class="sidebar-dots-trigger" onclick="toggleSidebarChipPopover(event, '${h.id}')">⋮</span>
          
          <div class="chip-popover-menu" id="chip-popover-${h.id}" onclick="event.stopPropagation();">
            <div class="popover-header-fixed">
              <div class="popover-section-title">Edit Name</div>
              <input type="text" class="chip-inline-input" value="${safeName}" onchange="editHabitNameGlobal('${h.id}', this.value)">
              <div class="popover-section-title">2-Min Fallback Rule</div>
              <input type="text" class="chip-inline-input" placeholder="e.g. ⚡ 5 Pushups" value="${safeMinRule}" onchange="editHabitMinRuleGlobal('${h.id}', this.value)">
            </div>
            <button class="chip-popover-btn delete-action" onclick="deleteHabitGlobal('${h.id}');">🗑️ Delete Task</button>
          </div>
        </div>
        
        ${h.minRuleText ? `<div class="habit-2min-subtitle">⚡ 2-min: ${h.minRuleText}</div>` : ''}
        
        <div style="display: flex; gap: 6px; align-items: center; width: 100%; margin-top: 2px;">
          <div class="habit-weekday-grid">
    `;

    daysOfWeek.forEach(d => {
      let val = currentWeekHistory[d];
      let isDone = val !== null && val !== undefined && val !== false && val !== '';
      const isToday = (d === todayKey);
      let dayClasses = "habit-day-dot";
      if (isDone) dayClasses += " completed";
      if (isToday) dayClasses += " is-today";

      let displayDotContent = d;
      let tooltipTitle = isToday ? 'TODAY' : d;

      if (isDone) {
        if (hType === 'count') {
          displayDotContent = val;
          tooltipTitle = `${d}: Count ${val}`;
        } else if (hType === 'log') {
          displayDotContent = '📝';
          tooltipTitle = `${d}: ${val}`;
        } else {
          displayDotContent = '✓';
          tooltipTitle = `${d}: Done`;
        }
      }

      cardHTML += `
        <div class="${dayClasses}" title="${tooltipTitle}" onclick="handleHabitDayClick(event, '${h.id}', '${d}', '${hType}')">${displayDotContent}</div>
      `;
    });

    cardHTML += `
          </div>
          <button class="analytics-view-btn" onclick="openHabitAnalyticsMatrix(event, '${h.id}')" title="Review Long-term History">📊 History</button>
        </div>
      </div>
    `;
    return cardHTML;
  };

  let html = "";

  // 1. CONDITIONAL SECTION: PINNED TRACKERS (Pinned Tracker Tasks)
  const sortedPinned = sortHabitsGroup(pinnedHabits);

  if (sortedPinned.length > 0) {
    const pinnedCollapsed = trackerLabelLineCollapsedState.pinned !== undefined ? trackerLabelLineCollapsedState.pinned : true;
    const pinnedArrow = pinnedCollapsed ? '▶' : '▼';

    html += `
      <div class="section-title execute-now-section-title" onclick="toggleTrackerLabelLineSectionCollapse('pinned')">
        <span>📌 PINNED TRACKERS <span style="font-size: 9px; margin-left: 2px;">${pinnedArrow}</span></span>
        <span>(${sortedPinned.length})</span>
      </div>
      <div class="tracker-dashboard-grid ${pinnedCollapsed ? 'collapsed' : ''}" style="margin-bottom: 12px;">
    `;
    sortedPinned.forEach(h => { html += renderSingleHabitCard(h, true); });
    html += `</div>`;
  }

  // 2. TRACKER LABEL LINE SECTIONS
  const allTrackerLabels = Array.from(getUniqueTrackerLabels());
  const pinnedLabelRegistry = Array.isArray(pinnedTrackerLabelsRegistry) ? pinnedTrackerLabelsRegistry : [];

  const pinnedLabels = allTrackerLabels.filter(l => pinnedLabelRegistry.includes(l)).sort((a,b) => a.localeCompare(b));
  const unpinnedLabels = allTrackerLabels.filter(l => !pinnedLabelRegistry.includes(l)).sort((a,b) => a.localeCompare(b));
  const noLabelHabits = regularHabits.filter(h => !h.labels || h.labels.length === 0);

  const renderSingleTrackerLabelSection = (labelName, isPinnedLabel, isNoLabel = false) => {
    const labelKey = isNoLabel ? '__NO_LABEL__' : labelName;
    if (trackerLabelLineCollapsedState[labelKey] === undefined) {
      trackerLabelLineCollapsedState[labelKey] = true;
    }
    const isCollapsed = trackerLabelLineCollapsedState[labelKey];
    const arrow = isCollapsed ? '▶' : '▼';

    let matchingHabits = [];
    if (isNoLabel) {
      matchingHabits = sortHabitsGroup(noLabelHabits);
    } else {
      matchingHabits = sortHabitsGroup(regularHabits.filter(h => h.labels && h.labels.includes(labelName)));
    }

    const base64 = btoa(encodeURIComponent(labelName)).replace(/=/g, '');
    const secClass = isPinnedLabel ? 'label-pinned-section-title' : 'macro-section-title';

    let pinIconHTML = '';
    let dotsMenuHTML = '';

    if (!isNoLabel) {
      pinIconHTML = `<span class="sidebar-pin-toggle" onclick="event.stopPropagation(); toggleTrackerLabelPin(event, '${labelName.replace(/'/g, "\\'")}')" title="${isPinnedLabel ? 'Unpin Label Priority' : 'Pin Label to Top Priority'}">${isPinnedLabel ? '📌' : '📍'}</span>`;
      dotsMenuHTML = `
        <span class="sidebar-dots-trigger" onclick="toggleSidebarChipPopover(event, 'trk-hdr-${base64}')" title="Label Actions">⋮</span>
        <div class="chip-popover-menu" id="chip-popover-trk-hdr-${base64}" onclick="event.stopPropagation();">
          <div class="popover-header-fixed">
            <div class="popover-section-title">Edit Name</div>
            <input type="text" class="chip-inline-input" value="${labelName}" onchange="editTrackerLabelNameGlobal('${labelName.replace(/'/g, "\\'")}', this.value)">
          </div>
          <button class="chip-popover-btn delete-action" onclick="deleteTrackerLabelGlobal('${labelName.replace(/'/g, "\\'")}');">🗑️ Delete Label</button>
        </div>
      `;
    }

    const labelTitleDisplay = isNoLabel ? `⚪ NO LABEL` : `🏷️ ${labelName}`;

    html += `
      <div class="section-title ${secClass}" onclick="toggleTrackerLabelLineSectionCollapse('${labelKey.replace(/'/g, "\\'")}')">
        <div style="display:flex; align-items:center; gap:6px;">
          ${pinIconHTML}
          <span>${labelTitleDisplay} <span style="font-size: 9px; margin-left: 2px;">${arrow}</span></span>
        </div>
        <span>(${matchingHabits.length})</span>
        ${dotsMenuHTML}
      </div>
    `;

    if (matchingHabits.length > 0) {
      html += `<div class="tracker-dashboard-grid ${isCollapsed ? 'collapsed' : ''}" style="margin-bottom: 12px;">`;
      matchingHabits.forEach(h => { html += renderSingleHabitCard(h, pinnedRegistry.includes(h.id)); });
      html += `</div>`;
    } else {
      html += `<div class="tracker-dashboard-grid ${isCollapsed ? 'collapsed' : ''}" style="font-size:12px; color:#80868b; font-style:italic; padding:4px 0 12px 12px;">No tasks</div>`;
    }
  };

  if (currentTrackerLabelFilter === 'ALL') {
    pinnedLabels.forEach(lbl => renderSingleTrackerLabelSection(lbl, true, false));
    unpinnedLabels.forEach(lbl => renderSingleTrackerLabelSection(lbl, false, false));
    renderSingleTrackerLabelSection('No Label', false, true);
  } else if (currentTrackerLabelFilter === 'NONE') {
    renderSingleTrackerLabelSection('No Label', false, true);
  } else {
    const isPinnedLbl = pinnedLabelRegistry.includes(currentTrackerLabelFilter);
    renderSingleTrackerLabelSection(currentTrackerLabelFilter, isPinnedLbl, false);
  }

  targetPanel.innerHTML = html;
}

function calculateWeeklyCompletedCount(yearlyGrid, currentWeekKey) {
  const daysOrder = ['M', 'T', 'W', 'Th', 'F', 'Sa', 'Su'];
  const weekHistory = (yearlyGrid && yearlyGrid[currentWeekKey]) ? yearlyGrid[currentWeekKey] : {};
  let completedCount = 0;
  daysOrder.forEach(key => {
    let val = weekHistory[key];
    let isDone = val !== null && val !== undefined && val !== false && val !== '';
    if (isDone) completedCount++;
  });
  return completedCount;
}

window.toggleModalDropdown = function(e, menuId) {
  e.stopPropagation();
  document.querySelectorAll('.dropdown-menu').forEach(m => {
    if (m.id !== menuId) m.classList.remove('show');
  });
  document.querySelectorAll('.note-card').forEach(c => c.classList.remove('menu-open'));

  const targetMenu = document.getElementById(menuId);
  if (targetMenu) {
    const isShowing = targetMenu.classList.toggle('show');
    if (isShowing) {
      const parentCard = targetMenu.closest('.note-card');
      if (parentCard) parentCard.classList.add('menu-open');
    }
  }
};

/* IN-CARD DIRECT EDITING ENGINE */
window.startInCardEditing = function(event, noteId) {
  if (event) event.stopPropagation();
  if (activeInlineEditingNoteId === noteId) return;

  if (activeInlineEditingNoteId) {
    saveInCardNoteDirect(activeInlineEditingNoteId);
  }
  if (isInlineCreatorExpanded) {
    saveAndCloseInlineCreator();
  }

  const note = notes.find(n => n.id === noteId);
  if (!note) return;

  activeInlineEditingNoteId = noteId;
  inCardLabelsState = note.labels ? [...note.labels] : [];
  inCardStrictState = !!note.isStrict;
  inCardPinnedState = !!note.pinned;
  inCardColorState = note.color || '#ffffff';

  const rawText = note.text || '';
  const isChecklist = rawText.includes('[ ]') || rawText.includes('[x]') || rawText.includes('[X]');
  if (isChecklist) {
    inCardChecklistLines = parseTextToLines(rawText);
  } else {
    inCardChecklistLines = [];
  }

  renderNotes();
};

window.cancelInCardEditing = function(event, noteId) {
  if (event) event.stopPropagation();
  activeInlineEditingNoteId = null;
  renderNotes();
};

window.saveInCardNoteDirect = async function(noteId) {
  const titleInput = document.getElementById(`in-title-${noteId}`);
  const textInput = document.getElementById(`in-text-${noteId}`);

  if (!titleInput) return;

  const t = titleInput.value.trim();
  let txt = "";

  const checklistContainer = document.getElementById(`in-checklist-container-${noteId}`);
  if (checklistContainer && checklistContainer.style.display !== 'none') {
    txt = inCardChecklistLines
      .map(l => l.trim())
      .filter(l => l.replace(/^\[[ xX]\]\s*/, '').length > 0)
      .join('\n');
  } else if (textInput) {
    txt = textInput.value.trim();
    if (txt.includes('[ ]') || txt.includes('[x]')) {
      txt = txt.replace(/\s*\[\s*\]\s*/g, '\n[ ] ').replace(/\s*\[\s*[xX]\s*\]\s*/g, '\n[x] ').split('\n').map(l=>l.trim()).filter(l=>l.length>0).join('\n');
    }
  }

  activeInlineEditingNoteId = null;

  await updateNoteField(noteId, {
    title: t,
    text: txt,
    isStrict: inCardStrictState,
    labels: inCardLabelsState
  });
};

window.toggleInCardStrictState = function(event, noteId) {
  if (event) event.stopPropagation();
  inCardStrictState = !inCardStrictState;
  const btn = document.getElementById(`in-strict-btn-${noteId}`);
  if (btn) {
    if (inCardStrictState) btn.classList.add('active');
    else btn.classList.remove('active');
  }
};

window.toggleInCardCheckboxMenu = function(event, noteId) {
  if (event) event.stopPropagation();
  document.querySelectorAll('.checkbox-dropdown-menu').forEach(m => {
    if(m.id !== `in-card-label-menu-${noteId}`) m.classList.remove('show');
  });
  const menu = document.getElementById(`in-card-label-menu-${noteId}`);
  if (menu) {
    const isShowing = menu.classList.toggle('show');
    if (isShowing) {
      renderInCardLabelsDropdown(noteId, '');
      setTimeout(() => {
        const inputEl = document.getElementById(`in-label-search-${noteId}`);
        if (inputEl) inputEl.focus();
      }, 10);
    }
  }
};

function renderInCardLabelsDropdown(noteId, searchTerm = "") {
  const sb = document.getElementById(`in-label-scroll-${noteId}`);
  if (!sb) return;
  const all = getUniqueLabels();
  let h = "";
  let exactMatch = false;

  all.forEach(l => {
    if (l.toLowerCase() === searchTerm.toLowerCase()) exactMatch = true;
    if (!searchTerm || l.toLowerCase().includes(searchTerm.toLowerCase())) {
      const chk = inCardLabelsState.includes(l) ? 'checked' : '';
      h += `
        <label class="checkbox-item" onclick="event.stopPropagation();">
          <input type="checkbox" value="${l}" ${chk} onchange="handleInCardLabelToggle('${noteId}', this.value, this.checked)">
          <span>${l}</span>
        </label>
      `;
    }
  });

  if (searchTerm && !exactMatch) {
    h = `
      <div class="checkbox-item" onclick="event.stopPropagation(); addNewInCardLabel('${noteId}', '${searchTerm.replace(/'/g, "\\'")}')" style="color:#1a73e8; font-weight:600;">
        <span>➕ Create "${searchTerm}"</span>
      </div>
    ` + h;
  }

  if (!h) {
    h = `<div style="font-size:12px; color:#5f6368; padding:6px;">No matching labels</div>`;
  }
  sb.innerHTML = h;
}

window.handleInCardLabelToggle = function(noteId, labelVal, isChecked) {
  if (isChecked) {
    if (!inCardLabelsState.includes(labelVal)) inCardLabelsState.push(labelVal);
  } else {
    inCardLabelsState = inCardLabelsState.filter(l => l !== labelVal);
  }
  renderInCardSelectedLabelsBar(noteId);
};

window.addNewInCardLabel = function(noteId, labelName) {
  labelName = labelName.trim();
  if (!labelName) return;
  if (!inCardLabelsState.includes(labelName)) inCardLabelsState.push(labelName);
  renderInCardSelectedLabelsBar(noteId);
  renderInCardLabelsDropdown(noteId, '');
};

function renderInCardSelectedLabelsBar(noteId) {
  const container = document.getElementById(`in-selected-labels-${noteId}`);
  if (!container) return;
  if (inCardLabelsState.length === 0) {
    container.innerHTML = '';
    return;
  }
  container.innerHTML = inCardLabelsState.map(l => `
    <span class="modal-label-chip">
      🏷️ ${l}
      <span class="modal-label-chip-remove" onclick="removeInCardLabelChip(event, '${noteId}', '${l.replace(/'/g, "\\'")}')">✕</span>
    </span>
  `).join('');
}

window.removeInCardLabelChip = function(event, noteId, lbl) {
  if (event) event.stopPropagation();
  inCardLabelsState = inCardLabelsState.filter(l => l !== lbl);
  renderInCardSelectedLabelsBar(noteId);
  renderInCardLabelsDropdown(noteId, '');
};

window.toggleInCardChecklistFormat = function(event, noteId) {
  if (event) event.stopPropagation();
  const textEl = document.getElementById(`in-text-${noteId}`);
  const checklistContainer = document.getElementById(`in-checklist-container-${noteId}`);

  if (checklistContainer.style.display !== 'none') {
    const plainText = inCardChecklistLines.map(l => l.replace(/^\[[ xX]\]\s*/, '')).filter(l => l.length > 0).join('\n');
    textEl.value = plainText;
    textEl.style.display = 'block';
    checklistContainer.style.display = 'none';
  } else {
    inCardChecklistLines = parseTextToLines(buildCleanKeepChecklistString(textEl.value));
    if (inCardChecklistLines.length === 0) inCardChecklistLines = ['[ ] '];
    textEl.style.display = 'none';
    checklistContainer.style.display = 'flex';
    renderInCardChecklistUI(noteId, 0);
  }
  autoScaleTextarea(textEl);
};

window.toggleInCardNumberedListFormat = function(event, noteId) {
  if (event) event.stopPropagation();
  const textEl = document.getElementById(`in-text-${noteId}`);
  let lines = textEl.value.split('\n');
  let isNum = lines.every(l => l.trim().match(/^\d+\.\s*/) || l.trim() === '');
  textEl.value = isNum ? lines.map(l => cleanFormattingPrefixes(l)).join('\n') : lines.map((l, i) => l.trim()===''?'':`${i+1}. ${cleanFormattingPrefixes(l)}`).join('\n');
  autoScaleTextarea(textEl);
};

function renderInCardChecklistUI(noteId, focusIndex = -1) {
  const container = document.getElementById(`in-checklist-container-${noteId}`);
  if (!container) return;

  if (inCardChecklistLines.length === 0) {
    inCardChecklistLines = ['[ ] '];
  }

  let uncheckedHTML = "";
  let checkedHTML = "";
  let checkedCount = 0;

  inCardChecklistLines.forEach((line, index) => {
    let isChecked = line.startsWith('[x] ') || line.startsWith('[X] ');
    let cleanedText = line.replace(/^\[[ xX]\]\s*/, '');

    let rowHTML = `
      <div class="editor-checklist-item inline-todo-row" 
           data-index="${index}"
           draggable="true" 
           ondragstart="handleInCardDragStart(event, ${index})"
           ondragover="handleDragOver(event)"
           ondrop="handleInCardDrop(event, '${noteId}', ${index})"
           ondragend="handleDragEnd(event)">
        <span class="drag-dots-handle" 
              title="Drag or touch & hold to reorder"
              ontouchstart="handleInCardTouchStart(event, ${index})"
              ontouchmove="handleTouchMoveHandle(event)"
              ontouchend="handleInCardTouchEnd(event, '${noteId}')">⣿</span>
        <input type="checkbox" class="inline-todo-input-check" ${isChecked ? 'checked' : ''} 
               onchange="handleInCardCheckToggle('${noteId}', ${index}, this.checked)">
        <input type="text" id="in-item-input-${noteId}-${index}" value="${cleanedText.replace(/"/g, '&quot;')}" 
               placeholder="List item"
               oninput="handleInCardItemTextChange(${index}, this.value)"
               onkeydown="handleInCardItemKeydown(event, '${noteId}', ${index})">
        <button class="editor-item-del-btn" title="Remove item" onclick="handleInCardDeleteLine('${noteId}', ${index})">✕</button>
      </div>
    `;

    if (isChecked) {
      checkedCount++;
      checkedHTML += rowHTML;
    } else {
      uncheckedHTML += rowHTML;
    }
  });

  let finalHTML = uncheckedHTML;
  finalHTML += `
    <div class="editor-add-row" onclick="event.stopPropagation(); addInCardChecklistItem('${noteId}')">
      <span>+</span>
      <span style="font-size:13px;">List item</span>
    </div>
  `;

  if (checkedCount > 0) {
    const collapseKey = `edit-${noteId}`;
    const isExpanded = completedListsCollapsedState[collapseKey] || false;
    const arrow = isExpanded ? '▼' : '▶';
    const displayStyle = isExpanded ? 'flex' : 'none';

    finalHTML += `
      <div class="completed-divider-bar" onclick="toggleCompletedTasksCollapse(event, '${collapseKey}')">
        <span id="completed-arrow-${collapseKey}" style="margin-right: 4px; font-size: 10px;">${arrow}</span>
        <span>${checkedCount} completed ${checkedCount === 1 ? 'item' : 'items'}</span>
      </div>
      <div class="completed-items-wrapper" id="completed-items-${collapseKey}" style="display: ${displayStyle};">
        ${checkedHTML}
      </div>
    `;
  }

  container.innerHTML = finalHTML;

  if (focusIndex >= 0) {
    setTimeout(() => {
      const el = document.getElementById(`in-item-input-${noteId}-${focusIndex}`);
      if (el) { el.focus(); el.selectionStart = el.selectionEnd = el.value.length; }
    }, 10);
  }
}

window.addInCardChecklistItem = function(noteId) {
  inCardChecklistLines.push('[ ] ');
  renderInCardChecklistUI(noteId, inCardChecklistLines.length - 1);
};

window.handleInCardCheckToggle = function(noteId, idx, isChecked) {
  let line = inCardChecklistLines[idx];
  let cleaned = line.replace(/^\[[ xX]\]\s*/, '');
  inCardChecklistLines[idx] = (isChecked ? '[x] ' : '[ ] ') + cleaned;
  renderInCardChecklistUI(noteId);
};

window.handleInCardItemTextChange = function(idx, newText) {
  let isChecked = inCardChecklistLines[idx].startsWith('[x] ') || inCardChecklistLines[idx].startsWith('[X] ');
  inCardChecklistLines[idx] = (isChecked ? '[x] ' : '[ ] ') + newText;
};

window.handleInCardItemKeydown = function(e, noteId, idx) {
  if (e.key === 'Enter' || e.keyCode === 13) {
    e.preventDefault();
    inlineCreatorChecklistLines.splice(idx + 1, 0, '[ ] ');
    renderInCardChecklistUI(noteId, idx + 1);
  } else if (e.key === 'Backspace' && e.target.value === '') {
    if (inCardChecklistLines.length > 1) {
      e.preventDefault();
      inCardChecklistLines.splice(idx, 1);
      renderInCardChecklistUI(noteId, Math.max(0, idx - 1));
    }
  }
};

window.handleInCardDeleteLine = function(noteId, idx) {
  const removed = inCardChecklistLines.splice(idx, 1)[0];
  recordDeletedAction('IN_CARD_LINE', { noteId, index: idx, line: removed }, `Checklist line deleted`);
  if (inCardChecklistLines.length === 0) inCardChecklistLines = ['[ ] '];
  renderInCardChecklistUI(noteId, Math.max(0, idx - 1));
};

let inCardDraggedIndex = null;
window.handleInCardDragStart = function(e, index) {
  e.stopPropagation();
  inCardDraggedIndex = index;
  e.target.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', index);
};

window.handleInCardDrop = function(e, noteId, targetIndex) {
  if(e) {
    e.preventDefault();
    e.stopPropagation();
  }
  document.querySelectorAll(`#in-checklist-container-${noteId} .editor-checklist-item`).forEach(r => r.classList.remove('dragging'));
  if (inCardDraggedIndex === null || inCardDraggedIndex === targetIndex) return;

  const movedItem = inCardChecklistLines.splice(inCardDraggedIndex, 1)[0];
  inCardChecklistLines.splice(targetIndex, 0, movedItem);
  inCardDraggedIndex = null;
  renderInCardChecklistUI(noteId);
};

let inCardTouchStartData = null;
window.handleInCardTouchStart = function(e, index) {
  e.stopPropagation();
  const touch = e.touches[0];
  const row = e.target.closest('.editor-checklist-item');
  if(row) row.classList.add('dragging');

  inCardTouchStartData = {
    index,
    element: row,
    startY: touch.clientY
  };
};

window.handleInCardTouchEnd = function(e, noteId) {
  if (!inCardTouchStartData) return;
  if(e) e.stopPropagation();

  if(inCardTouchStartData.element) {
    inCardTouchStartData.element.classList.remove('dragging');
  }

  const fromIdx = inCardTouchStartData.index;
  const toIdx = inCardTouchStartData.currentTargetIndex;
  inlineCreatorTouchStartData = null;

  if (toIdx !== undefined && fromIdx !== toIdx) {
    const movedItem = inCardChecklistLines.splice(fromIdx, 1)[0];
    inCardChecklistLines.splice(toIdx, 0, movedItem);
    renderInCardChecklistUI(noteId);
  }
};

window.uncheckAllInCardItems = function(event, noteId) {
  if (event) event.stopPropagation();
  const checklistContainer = document.getElementById(`in-checklist-container-${noteId}`);
  const textEl = document.getElementById(`in-text-${noteId}`);

  if (checklistContainer && checklistContainer.style.display !== 'none') {
    inCardChecklistLines = inCardChecklistLines.map(l => {
      if (l.startsWith('[x] ') || l.startsWith('[X] ')) return '[ ] ' + l.substring(4);
      return l;
    });
    renderInCardChecklistUI(noteId);
  } else if (textEl) {
    let lines = parseTextToLines(textEl.value);
    let unchk = lines.map(l => {
      if (l.startsWith('[x] ') || l.startsWith('[X] ')) return '[ ] ' + l.substring(4);
      return l;
    });
    textEl.value = unchk.join('\n');
  }
};

window.deleteCheckedInCardItems = function(event, noteId) {
  if (event) event.stopPropagation();
  const checklistContainer = document.getElementById(`in-checklist-container-${noteId}`);
  const textEl = document.getElementById(`in-text-${noteId}`);

  if (checklistContainer && checklistContainer.style.display !== 'none') {
    const prev = [...inCardChecklistLines];
    inCardChecklistLines = inCardChecklistLines.filter(l => !l.startsWith('[x] ') && !l.startsWith('[X] '));
    recordDeletedAction('IN_CARD_LINES', { noteId, lines: prev }, "Checked items deleted");
    renderInCardChecklistUI(noteId);
  } else if (textEl) {
    let lines = parseTextToLines(textEl.value);
    let remaining = lines.filter(l => !l.startsWith('[x] ') && !l.startsWith('[X] '));
    textEl.value = remaining.join('\n');
  }
};

/* OPTIMISTIC PIN TOGGLE FOR SIDEBAR LABELS */
window.toggleLabelSidebarPin = async function(e, name) { 
  if (e) e.stopPropagation(); 
  let u = Array.isArray(pinnedLabelsRegistry) ? [...pinnedLabelsRegistry] : []; 
  if (u.includes(name)) u = u.filter(x => x !== name); 
  else u.push(name); 
  pinnedLabelsRegistry = u; 
  
  renderSidebars(); 
  renderNotes();

  await setDoc(settingsDocRef, { pinnedLabels: u }, { merge: true }); 
};

window.toggleSidebarChipPopover = function(e, id) { 
  e.stopPropagation(); 
  document.querySelectorAll('.chip-popover-menu').forEach(m => { if (m.id !== 'chip-popover-' + id) m.classList.remove('show'); }); 
  const p = document.getElementById('chip-popover-' + id); 
  if (p) p.classList.toggle('show'); 
};

window.editLabelNameGlobal = async function(old, nRaw) { 
  const n = nRaw.trim(); 
  if (!n || n === old) return; 

  notes.forEach(nt => {
    if (nt.labels && nt.labels.includes(old)) {
      nt.labels = nt.labels.map(x => x === old ? n : x);
    }
  });
  if (pinnedLabelsRegistry.includes(old)) {
    pinnedLabelsRegistry = pinnedLabelsRegistry.map(x => x === old ? n : x);
  }
  renderSidebars(); 
  renderNotes();

  const batch = writeBatch(db); 
  notes.forEach(nt => { 
    if (nt.labels && nt.labels.includes(n)) { 
      batch.update(doc(db, "notes", nt.id), { labels: nt.labels }); 
    } 
  }); 
  batch.set(settingsDocRef, { pinnedLabels: pinnedLabelsRegistry }, { merge: true }); 
  await batch.commit(); 
};

window.deleteLabelGlobal = async function(name) { 
  notes.forEach(nt => {
    if (nt.labels && nt.labels.includes(name)) {
      nt.labels = nt.labels.filter(x => x !== name);
    }
  });
  pinnedLabelsRegistry = pinnedLabelsRegistry.filter(x => x !== name);
  if (currentLabelFilter === name) currentLabelFilter = 'ALL';
  renderSidebars(); 
  renderNotes();

  const batch = writeBatch(db); 
  notes.forEach(nt => { batch.update(doc(db, "notes", nt.id), { labels: nt.labels || [] }); }); 
  batch.set(settingsDocRef, { pinnedLabels: pinnedLabelsRegistry }, { merge: true }); 
  await batch.commit(); 
};

function parseTextToLines(textStr) {
  if (!textStr) return [];
  let clean = textStr.replace(/\s*\[\s*\]\s*/g, '\n[ ] ').replace(/\s*\[\s*[xX]\s*\]\s*/g, '\n[x] ');
  return clean.split('\n').map(l => l.trim()).filter(l => l.length > 0);
}

function buildCleanKeepChecklistString(rawText) {
  let lines = parseTextToLines(rawText);
  let isTodoStructure = lines.length > 0 && lines.every(l => l.startsWith('[ ] ') || l.startsWith('[x] '));
  if (isTodoStructure) {
    return lines.map(l => l.substring(4)).join('\n');
  } else {
    return lines.map(l => {
      if (l.startsWith('[ ] ') || l.startsWith('[x] ')) return l;
      return `[ ] ${l}`;
    }).join('\n');
  }
}

window.deleteCheckedItemsDirect = async function(e, noteId) {
  e.stopPropagation();
  document.querySelectorAll('.dropdown-menu').forEach(m => m.classList.remove('show'));
  document.querySelectorAll('.note-card').forEach(c => c.classList.remove('menu-open'));
  
  const targetNote = notes.find(n => n.id === noteId);
  if (!targetNote) return;
  
  let lines = parseTextToLines(targetNote.text);
  let remainingLines = lines.filter(l => !l.startsWith('[x] ') && !l.startsWith('[X] '));
  
  recordDeletedAction('NOTE_TEXT', { noteId, previousText: targetNote.text }, `Checked items deleted from "${targetNote.title || 'Note'}"`);
  await updateNoteField(noteId, { text: remainingLines.join('\n') });
};

window.uncheckAllItemsDirect = async function(e, noteId) {
  e.stopPropagation();
  document.querySelectorAll('.dropdown-menu').forEach(m => m.classList.remove('show'));
  document.querySelectorAll('.note-card').forEach(c => c.classList.remove('menu-open'));
  
  const targetNote = notes.find(n => n.id === noteId);
  if (!targetNote) return;
  
  let lines = parseTextToLines(targetNote.text);
  let uncheckedLines = lines.map(l => {
    if (l.startsWith('[x] ') || l.startsWith('[X] ')) {
      return '[ ] ' + l.substring(4);
    }
    return l;
  });
  
  await updateNoteField(noteId, { text: uncheckedLines.join('\n') });
};

window.handleDragOver = function(e) {
  e.preventDefault();
  e.stopPropagation();
  e.dataTransfer.dropEffect = 'move';
};

window.handleDragEnd = function(e) {
  e.target.classList.remove('dragging');
  inCardDraggedIndex = null;
  inlineCreatorDraggedIndex = null;
};

window.handleTouchMoveHandle = function(e) {
  if (!inCardTouchStartData && !inlineCreatorTouchStartData) return;
  e.preventDefault();
  e.stopPropagation();

  const touch = e.touches[0];
  const elementElem = document.elementFromPoint(touch.clientX, touch.clientY);
  if (!elementElem) return;

  const targetRow = elementElem.closest('.editor-checklist-item') || elementElem.closest('.inline-todo-row');
  if (targetRow && targetRow.dataset.index !== undefined) {
    const targetIdx = parseInt(targetRow.dataset.index, 10);
    if (inCardTouchStartData) inCardTouchStartData.currentTargetIndex = targetIdx;
    if (inlineCreatorTouchStartData) inlineCreatorTouchStartData.currentTargetIndex = targetIdx;
  }
};

window.toggleKeepItemStateInline = async function(e, noteId, itemIndexToToggle) {
  e.stopPropagation();
  const targetNote = notes.find(n => n.id === noteId);
  if (!targetNote) return;
  
  let lines = parseTextToLines(targetNote.text);
  let targetLine = lines[itemIndexToToggle];
  if (!targetLine) return;
  
  if (targetLine.startsWith('[ ] ')) {
    lines[itemIndexToToggle] = '[x] ' + targetLine.substring(4);
  } else if (targetLine.startsWith('[x] ')) {
    lines[itemIndexToToggle] = '[ ] ' + targetLine.substring(4);
  }
  
  let activeItems = [];
  let checkedItems = [];
  lines.forEach(l => {
    if (l.startsWith('[x] ') || l.startsWith('[X] ')) {
      checkedItems.push(l);
    } else {
      activeItems.push(l.startsWith('[ ] ') ? l : `[ ] ${l}`);
    }
  });
  
  let finalizedText = [...activeItems, ...checkedItems].join('\n');
  await updateNoteField(noteId, { text: finalizedText });
};

function bindKeepCheckboxInputInterceptor(textareaElement) {
  if(!textareaElement) return;
  textareaElement.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.keyCode === 13) {
      const start = textareaElement.selectionStart;
      const end = textareaElement.selectionEnd;
      const val = textareaElement.value;
      
      let lineStart = val.lastIndexOf('\n', start - 1) + 1;
      let currentLine = val.substring(lineStart, start);
      
      if (currentLine.startsWith('[ ] ') || currentLine.startsWith('[x] ')) {
        e.preventDefault();
        textareaElement.value = val.substring(0, start) + '\n[ ] ' + val.substring(end);
        textareaElement.selectionStart = textareaElement.selectionEnd = start + 5;
        autoScaleTextarea(textareaElement);
      }
    }
  });
}

window.toggleCardDatePopoverDirect = function(e, id) { 
  e.stopPropagation(); 
  const trigger = e.currentTarget;
  const dateMenu = trigger ? trigger.nextElementSibling : document.getElementById('read-card-date-menu-' + id);
  const card = trigger ? trigger.closest('.note-card') : document.getElementById('note-card-' + id);

  document.querySelectorAll('.checkbox-dropdown-menu').forEach(m => m.classList.remove('show')); 
  document.querySelectorAll('.custom-date-popover-menu').forEach(m => { if (m !== dateMenu) m.classList.remove('show'); }); 
  document.querySelectorAll('.dropdown-menu').forEach(m => m.classList.remove('show'));
  document.querySelectorAll('.note-card').forEach(c => { if (c !== card) c.classList.remove('menu-open'); });

  if (dateMenu) {
    const isShowing = dateMenu.classList.toggle('show'); 
    if (card) {
      if (isShowing) card.classList.add('menu-open');
      else card.classList.remove('menu-open');
    }
  }
};

window.toggleCardCheckboxMenuDirect = function(e, id) { 
  e.stopPropagation(); 
  const trigger = e.currentTarget;
  const wrapper = trigger ? trigger.parentElement.parentElement : null;
  const menu = wrapper ? wrapper.querySelector('.checkbox-dropdown-menu') : document.getElementById('read-card-checkbox-menu-popover-' + id);
  const card = trigger ? trigger.closest('.note-card') : document.getElementById('note-card-' + id);

  document.querySelectorAll('.custom-date-popover-menu').forEach(m => m.classList.remove('show')); 
  document.querySelectorAll('.checkbox-dropdown-menu').forEach(m => { if (m !== menu) m.classList.remove('show'); }); 
  document.querySelectorAll('.dropdown-menu').forEach(m => m.classList.remove('show'));
  document.querySelectorAll('.note-card').forEach(c => { if (c !== card) c.classList.remove('menu-open'); });

  const isShowing = menu ? menu.classList.toggle('show') : false; 
  if (card) {
    if (isShowing) card.classList.add('menu-open');
    else card.classList.remove('menu-open');
  }

  if (isShowing) {
    setTimeout(() => {
      const sb = menu.querySelector('.popover-scroll-body');
      if (sb) sb.scrollTop = 0;
    }, 10);
  }
};

window.savePopoverDateDirect = async function(e, id) { 
  e.stopPropagation(); 
  const val = document.getElementById('popover-date-input-' + id).value; 
  await updateNoteField(id, { dueDate: val }); 
};

window.clearPopoverDateDirect = async function(e, id) { 
  e.stopPropagation(); 
  await updateNoteField(id, { dueDate: "" }); 
};

window.handleGridCheckboxToggle = async function(e, id, val, chk, inId) { 
  e.stopPropagation(); 
  const el = document.getElementById(inId); 
  let arr = parseLabelsString(el.value); 
  if(chk) { if(!arr.includes(val)) arr.push(val); } else { arr = arr.filter(x => x !== val); } 
  el.value = arr.join(', '); 
  await updateNoteField(id, { labels: arr }); 
};

window.handleGridManualLabelSave = async function(e, id) { 
  e.stopPropagation(); 
  const el = document.getElementById('read-label-in-' + id); 
  const nt = notes.find(x => x.id === id); 
  let base = nt && nt.labels ? [...nt.labels] : []; 
  parseLabelsString(el.value).forEach(l => { if(!base.includes(l)) base.push(l); }); 
  await updateNoteField(id, { labels: base }); 
};

window.deleteNoteDirect = async function(e, id) { 
  e.stopPropagation(); 
  const deletedNote = notes.find(n => n.id === id);
  if (deletedNote) {
    recordDeletedAction('NOTE', { ...deletedNote }, `Note "${deletedNote.title || 'Untitled'}" deleted`);
  }

  if (activeInlineEditingNoteId === id) activeInlineEditingNoteId = null; 
  if (currentlyExpandedNoteId === id) currentlyExpandedNoteId = null; 
  notes = notes.filter(n => n.id !== id); 
  renderNotes(); 
  updateTopHeaderLabels(); 
  await deleteDoc(doc(db, "notes", id)); 
};

window.togglePinDirect = async function(e, id, stat) { 
  e.stopPropagation(); 
  const targetNote = notes.find(n => n.id === id);
  if (targetNote) {
    targetNote.pinned = !stat;
    renderNotes();
    updateTopHeaderLabels();
  }
  await updateDoc(doc(db, "notes", id), { pinned: !stat }); 
};

window.setLabelFilter = function(lbl) { 
  currentLabelFilter = lbl; 
  renderSidebars(); 
  renderNotes(); 
  updateTopHeaderLabels(); 
  closeAllSidebars();
};

window.toggleDropdown = function(e, id) { 
  e.stopPropagation(); 
  const btn = e.currentTarget;
  const menu = btn ? btn.nextElementSibling : document.getElementById('menu-' + id);
  const card = btn ? btn.closest('.note-card') : document.getElementById('note-card-' + id);

  document.querySelectorAll('.dropdown-menu').forEach(m => { if (m !== menu) m.classList.remove('show'); }); 
  document.querySelectorAll('.custom-date-popover-menu').forEach(m => m.classList.remove('show'));
  document.querySelectorAll('.checkbox-dropdown-menu').forEach(m => m.classList.remove('show'));
  document.querySelectorAll('.note-card').forEach(c => { if (c !== card) c.classList.remove('menu-open'); }); 
  
  if (menu) {
    const isShowing = menu.classList.toggle('show'); 
    if (card) {
      if (isShowing) card.classList.add('menu-open');
      else card.classList.remove('menu-open');
    }
  }
};

window.changeCardTheme = async function(e, id, hex) { 
  e.stopPropagation(); 
  await updateNoteField(id, { color: hex }); 
};

/* GLOBAL OUTSIDE CLICK DETECTOR */
document.addEventListener('click', (e) => {
  if (e.target.closest('#move-target-modal')) return;
  if (e.target.closest('.editor-add-row') || e.target.closest('.editor-checklist-item')) return;
  if (e.target.closest('.dropdown-menu') || e.target.closest('.dots-btn')) return;

  const inlineCreatorBox = document.getElementById('inline-creator-box');
  if (isInlineCreatorExpanded && inlineCreatorBox && !inlineCreatorBox.contains(e.target)) {
    if (!e.target.closest('.checkbox-dropdown-menu') && !e.target.closest('.dropdown-menu')) {
      saveAndCloseInlineCreator(e);
    }
  }

  const inlineTrackerCreatorBox = document.getElementById('inline-tracker-creator-box');
  if (isInlineTrackerCreatorExpanded && inlineTrackerCreatorBox && !inlineTrackerCreatorBox.contains(e.target)) {
    if (!e.target.closest('.checkbox-dropdown-menu') && !e.target.closest('.dropdown-menu')) {
      saveAndCloseInlineTrackerCreator(e);
    }
  }

  if (activeInlineEditingNoteId) {
    const activeEditingCard = document.getElementById(`note-card-${activeInlineEditingNoteId}`);
    if (activeEditingCard && !activeEditingCard.contains(e.target)) {
      if (!e.target.closest('.checkbox-dropdown-menu') && !e.target.closest('.dropdown-menu')) {
        saveInCardNoteDirect(activeInlineEditingNoteId);
      }
    }
  }

  if (currentlyExpandedNoteId) {
    const expandedCard = document.getElementById(`note-card-${currentlyExpandedNoteId}`);
    if (expandedCard && !expandedCard.contains(e.target)) {
      currentlyExpandedNoteId = null;
      renderNotes();
    }
  }

  if (!e.target.matches('.dots-btn') && !e.target.closest('.dropdown-menu')) {
    document.querySelectorAll('.dropdown-menu').forEach(m => { if(m.classList) m.classList.remove('show'); });
  }
  if (!e.target.closest('.interactive-date-trigger-tag') && !e.target.closest('.custom-date-popover-menu')) {
    document.querySelectorAll('.custom-date-popover-menu').forEach(m => { if(m.classList) m.classList.remove('show'); });
  }
  if (!e.target.closest('.individual-tag-chip') && !e.target.closest('.checkbox-dropdown-menu')) {
    document.querySelectorAll('.checkbox-dropdown-menu').forEach(m => { if(m.classList) m.classList.remove('show'); });
  }
  if (!e.target.closest('.icon-picker-btn') && !e.target.closest('.checkbox-dropdown-menu')) {
    document.querySelectorAll('.checkbox-dropdown-menu').forEach(m => { if(m.classList) m.classList.remove('show'); });
  }

  if (!e.target.closest('.menu-container') && !e.target.closest('.interactive-date-trigger-tag') && !e.target.closest('.individual-tag-chip') && !e.target.closest('.custom-date-popover-menu') && !e.target.closest('.checkbox-dropdown-menu')) {
    document.querySelectorAll('.note-card').forEach(c => c.classList.remove('menu-open'));
  }

  if (!e.target.matches('.sidebar-dots-trigger') && !e.target.closest('.chip-popover-menu')) {
    document.querySelectorAll('.chip-popover-menu').forEach(m => { if(m.classList) m.classList.remove('show'); });
  }
  if (!e.target.closest('.habit-type-select-btn') && !e.target.closest('.habit-type-popover')) {
    const pop = document.getElementById('habit-type-popover');
    if (pop) pop.classList.remove('show');
  }
});

document.addEventListener('keydown', (e) => {
  // Hotkey for Undo: Ctrl+Z or Cmd+Z
  if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
    if (!e.target.matches('input, textarea')) {
      e.preventDefault();
      triggerGlobalUndo();
    }
  }

  if ((e.ctrlKey || e.metaKey) && e.code === 'Space') {
    e.preventDefault();
    if (currentWorkspaceViewMode === 'TRACKER') expandInlineTrackerCreator(e);
    else expandInlineCreator(e);
  }
  if (e.key === 'Escape') {
    if (isInlineCreatorExpanded) discardInlineCreatorNote(e);
    if (isInlineTrackerCreatorExpanded) discardInlineTrackerCreator(e);
    if (activeInlineEditingNoteId) cancelInCardEditing(null, activeInlineEditingNoteId);
    if (currentlyExpandedNoteId) {
      currentlyExpandedNoteId = null;
      renderNotes();
    }
    closeMoveTargetModal();
    closeAllSidebars();
    closeMatrixModal();
    closeHabitModalInput();
    closeTrackerCreatorModal();
  }
});

function cleanFormattingPrefixes(l) { return l.replace(/^\[[ xX]\]\s*/, '').replace(/^[\u2611\u25FB\u25FE🔳☑️\uFE0F\s\d+\.\-]+/u, '').replace(/\u0336/g, ''); }
function getUniqueLabels() { const s = new Set(); notes.forEach(n => { if (n.labels) n.labels.forEach(l => s.add(l)); }); return s; }

function renderSidebars() {
  // 1. Tracker Labels Panel
  const sbTracker = document.getElementById('tracker-sidebar');
  if(sbTracker) {
    const allTrackerLabels = Array.from(getUniqueTrackerLabels());
    const trackerCounts = {};
    let noTrackerL = 0;

    habits.forEach(h => {
      if (!h.labels || h.labels.length === 0) noTrackerL++;
      else h.labels.forEach(l => { trackerCounts[l] = (trackerCounts[l] || 0) + 1; });
    });

    let th = `<div class="sidebar-title">Tracker Labels</div>`;
    th += `<div class="sidebar-item ${currentTrackerLabelFilter==='ALL'?'active':''}" onclick="setTrackerLabelFilter('ALL')"><span>📋 All Trackers</span><span class="badge">${habits.length}</span></div>`;
    th += `<div class="sidebar-item ${currentTrackerLabelFilter==='NONE'?'active':''}" onclick="setTrackerLabelFilter('NONE')"><span>⚪ No Label</span><span class="badge">${noTrackerL}</span></div>`;

    const pinnedTrackerRegistry = Array.isArray(pinnedTrackerLabelsRegistry) ? pinnedTrackerLabelsRegistry : [];
    const pinnedTrackerList = allTrackerLabels.filter(l => pinnedTrackerRegistry.includes(l));
    const unpinnedTrackerList = allTrackerLabels.filter(l => !pinnedTrackerRegistry.includes(l));

    const renderTrackerLabelItem = (l) => {
      const isPinned = pinnedTrackerRegistry.includes(l);
      return `<div class="sidebar-item ${currentTrackerLabelFilter===l?'active':''}">
        <span class="sidebar-pin-toggle" onclick="toggleTrackerLabelPin(event, '${l.replace(/'/g, "\\'")}')" title="${isPinned ? 'Unpin' : 'Pin'}">${isPinned ? '📌' : '📍'}</span>
        <span style="flex-grow:1; font-weight:600;" onclick="setTrackerLabelFilter('${l.replace(/'/g, "\\'")}')">${l}</span>
        <span class="badge">${trackerCounts[l]||0}</span>
      </div>`;
    };

    if (pinnedTrackerList.length > 0) {
      th += `<div class="sidebar-title execute-now-header">⭐ PINNED TRACKERS</div>`;
      pinnedTrackerList.forEach(l => { th += renderTrackerLabelItem(l); });
      th += `<div class="sidebar-title" style="margin-top:10px;">Other Trackers</div>`;
    }

    unpinnedTrackerList.forEach(l => { th += renderTrackerLabelItem(l); });
    sbTracker.innerHTML = th;
  }

  // 2. Timeline Labels Panel
  const sbTimeline = document.getElementById('label-sidebar'); 
  if(sbTimeline) {
    const all = Array.from(getUniqueLabels());
    const counts = {}; 
    let noL = 0; 

    notes.forEach(n => { 
      if (!n.labels || n.labels.length === 0) noL++; 
      else n.labels.forEach(l => { counts[l] = (counts[l] || 0) + 1; });
    });
    
    let h = `<div class="sidebar-title">Timeline Labels</div>`;
    h += `<div class="sidebar-item ${currentLabelFilter==='NONE'?'active':''}" onclick="setLabelFilter('NONE')"><span>⚪ No Label</span><span class="badge">${noL}</span></div>`;
    
    const pinnedRegistry = Array.isArray(pinnedLabelsRegistry) ? pinnedLabelsRegistry : [];
    const pinnedList = all.filter(l => pinnedRegistry.includes(l));
    const unpinnedList = all.filter(l => !pinnedRegistry.includes(l));

    const renderLabelItem = (l, isExecuteNow) => {
      const base64 = btoa(encodeURIComponent(l)).replace(/=/g, '');
      return `<div class="sidebar-item ${isExecuteNow ? 'execute-now-item' : ''} ${currentLabelFilter===l?'active':''}"><span class="sidebar-pin-toggle" onclick="toggleLabelSidebarPin(event, '${l.replace(/'/g, "\\'")}')">${pinnedRegistry.includes(l)?'📌':'📍'}</span><span style="flex-grow:1; font-weight:600;" onclick="setLabelFilter('${l.replace(/'/g, "\\'")}')">${l}</span><span class="badge">${counts[l]||0}</span><span class="sidebar-dots-trigger" onclick="toggleSidebarChipPopover(event, '${base64}')">⋮</span><div class="chip-popover-menu" id="chip-popover-${base64}"><div class="popover-header-fixed"><div class="popover-section-title">Edit Name</div><input type="text" class="chip-inline-input" value="${l}" onchange="editLabelNameGlobal('${l.replace(/'/g, "\\'")}', this.value)"></div><button class="chip-popover-btn delete-action" onclick="deleteLabelGlobal('${l.replace(/'/g, "\\'")}');">🗑️ Delete</button></div></div>`;
    };

    if (pinnedList.length > 0) {
      h += `<div class="sidebar-title execute-now-header">⚡ EXECUTE NOW</div>`;
      pinnedList.forEach(l => { h += renderLabelItem(l, true); });
      h += `<div class="sidebar-title" style="margin-top:10px;">Other Projects</div>`;
    }

    unpinnedList.forEach(l => { h += renderLabelItem(l, false); });
    sbTimeline.innerHTML = h;
  }
}

function createInlineTrackerCreatorDOM() {
  const container = document.createElement('div');
  container.id = 'inline-tracker-creator-box';
  container.className = 'inline-note-creator-container';
  container.style.backgroundColor = '#ffffff';

  if (!isInlineTrackerCreatorExpanded) {
    container.innerHTML = `
      <div class="inline-creator-collapsed-bar" onclick="expandInlineTrackerCreator(event)">
        <span>Create a tracker task...</span>
        <div class="inline-creator-collapsed-tools" onclick="event.stopPropagation();">
          <button class="icon-picker-btn" style="height:26px; min-width:28px; padding:2px 6px;" onclick="expandInlineTrackerCreator(event); setInlineTrackerCreatorType(event, 'boolean');" title="Checkmark tracker">☑️</button>
          <button class="icon-picker-btn" style="height:26px; min-width:28px; padding:2px 6px;" onclick="expandInlineTrackerCreator(event); setInlineTrackerCreatorType(event, 'count');" title="Numeric Count tracker">🔢</button>
          <button class="icon-picker-btn" style="height:26px; min-width:28px; padding:2px 6px;" onclick="expandInlineTrackerCreator(event); setInlineTrackerCreatorType(event, 'log');" title="Detailed Log tracker">📝</button>
          <button class="icon-picker-btn" style="height:26px; min-width:28px; padding:2px 6px;" onclick="expandInlineTrackerCreator(event); toggleInlineTrackerCreatorCheckboxMenu(event);" title="Assign labels">🏷️</button>
        </div>
      </div>
    `;
    return container;
  }

  const getBtnStyle = (t) => inlineTrackerCreatorTypeState === t
    ? 'background:#e8f0fe; border-color:#1a73e8; color:#1a73e8; font-weight:700;'
    : 'background:#fff; border-color:#dadce0; color:#5f6368;';

  container.innerHTML = `
    <div class="card-edit-toolbar" onclick="event.stopPropagation();">
      <div style="display:flex; align-items:center; gap:4px; flex-wrap:wrap;">
        <button class="icon-picker-btn inline-trk-type-btn" data-type="boolean" style="height:24px; padding:2px 6px; font-size:11px; ${getBtnStyle('boolean')}" onclick="setInlineTrackerCreatorType(event, 'boolean')" title="Checkmark Task">☑️ Check</button>
        <button class="icon-picker-btn inline-trk-type-btn" data-type="count" style="height:24px; padding:2px 6px; font-size:11px; ${getBtnStyle('count')}" onclick="setInlineTrackerCreatorType(event, 'count')" title="Numeric Count Task">🔢 Count</button>
        <button class="icon-picker-btn inline-trk-type-btn" data-type="log" style="height:24px; padding:2px 6px; font-size:11px; ${getBtnStyle('log')}" onclick="setInlineTrackerCreatorType(event, 'log')" title="Detailed Log Task">📝 Log</button>

        <div style="position:relative; display:inline-block;">
          <button class="icon-picker-btn" style="height:24px; min-width:24px; padding:2px 6px; font-size:11px;" onclick="toggleInlineTrackerCreatorCheckboxMenu(event)" title="Assign Tracker Labels">🏷️</button>
          <div class="checkbox-dropdown-menu" id="inline-trk-checkbox-menu" onclick="event.stopPropagation();">
            <div class="popover-header-fixed">
              <div class="popover-section-title">Label tracker task</div>
              <div class="popover-input-wrapper">
                <input type="text" id="inline-trk-label-search" class="label-input" placeholder="Enter label name" oninput="renderInlineTrackerCreatorLabelsDropdown(this.value)" onkeydown="if(event.key==='Enter'){event.preventDefault(); addNewInlineTrackerCreatorLabel(this.value); this.value='';}">
                <span class="search-icon">🔍</span>
              </div>
            </div>
            <div class="popover-scroll-body" id="inline-trk-label-scroll"></div>
          </div>
        </div>
      </div>

      <div style="display:flex; align-items:center; gap:4px;">
        <button class="creator-pin-btn ${inlineTrackerCreatorPinnedState ? 'active' : ''}" id="inline-trk-pin-btn" style="font-size:14px; padding:2px; background:none; border:none; cursor:pointer;" onclick="toggleInlineTrackerCreatorPin(event)" title="Pin to Execute Now">${inlineTrackerCreatorPinnedState ? '📌' : '📍'}</button>
        <button class="btn" style="padding:2px 8px; font-size:11px; height:26px; background:#5f6368;" onclick="discardInlineTrackerCreator(event)">Cancel</button>
        <button class="btn" style="padding:2px 10px; font-size:11px; height:26px;" onclick="saveAndCloseInlineTrackerCreator(event)">Save</button>
      </div>
    </div>

    <div class="modal-selected-labels-bar" id="inline-trk-selected-labels-bar"></div>

    <input type="text" id="inline-trk-title" class="card-edit-title-input" placeholder="Tracker task title (e.g., Daily Workout, Code 1 hour)" onkeydown="if(event.key==='Enter'){event.preventDefault(); saveAndCloseInlineTrackerCreator(event);}">
    <input type="text" id="inline-trk-minrule" class="card-edit-textarea" style="min-height:28px; height:28px; font-size:12px; color:#5f6368; margin-top:2px;" placeholder="⚡ 2-Min Fallback Rule (Optional, e.g., 5 Pushups)" onkeydown="if(event.key==='Enter'){event.preventDefault(); saveAndCloseInlineTrackerCreator(event);}">
  `;

  setTimeout(() => {
    renderInlineTrackerCreatorSelectedLabelsBar();
  }, 10);

  return container;
}

function createInlineCreatorDOM() {
  const container = document.createElement('div');
  container.id = 'inline-creator-box';
  container.className = 'inline-note-creator-container';
  container.style.backgroundColor = inlineCreatorColorState;

  if (!isInlineCreatorExpanded) {
    container.innerHTML = `
      <div class="inline-creator-collapsed-bar" onclick="expandInlineCreator(event)">
        <span>Take a note or checklist...</span>
        <div class="inline-creator-collapsed-tools" onclick="event.stopPropagation();">
          <button class="icon-picker-btn" style="height:26px; min-width:28px; padding:2px 6px;" onclick="expandInlineCreator(event); toggleInlineCreatorChecklistFormat(event);" title="New checklist">☑️</button>
          <button class="icon-picker-btn" style="height:26px; min-width:28px; padding:2px 6px;" onclick="expandInlineCreator(event); toggleInlineCreatorCheckboxMenu(event);" title="Assign labels">🏷️</button>
        </div>
      </div>
    `;
    return container;
  }

  const isChecklist = inlineCreatorChecklistLines.length > 0;
  container.innerHTML = `
    <div class="card-edit-toolbar" onclick="event.stopPropagation();">
      <div style="display:flex; align-items:center; gap:4px; flex-wrap:wrap;">
        <button class="icon-picker-btn" style="height:24px; min-width:24px; padding:2px 4px; font-size:11px;" onclick="toggleInlineCreatorNumberedList(event)" title="Format as 1.2.3 list">🔢</button>
        <button class="icon-picker-btn" style="height:24px; min-width:24px; padding:2px 4px; font-size:11px;" onclick="toggleInlineCreatorChecklistFormat(event)" title="Format as checkboxes">☑️</button>

        <div style="position:relative; display:inline-block;">
          <button class="icon-picker-btn" style="height:24px; min-width:24px; padding:2px 4px; font-size:11px;" onclick="toggleInlineCreatorCheckboxMenu(event)" title="Assign Labels">🏷️</button>
          <div class="checkbox-dropdown-menu" id="inline-c-checkbox-menu" onclick="event.stopPropagation();">
            <div class="popover-header-fixed">
              <div class="popover-section-title">Label note</div>
              <div class="popover-input-wrapper">
                <input type="text" id="inline-c-label-search" class="label-input" placeholder="Enter label name" oninput="renderInlineCreatorLabelsDropdown(this.value)" onkeydown="if(event.key==='Enter'){event.preventDefault(); addNewInlineCreatorLabel(this.value); this.value='';}">
                <span class="search-icon">🔍</span>
              </div>
            </div>
            <div class="popover-scroll-body" id="inline-c-label-scroll"></div>
          </div>
        </div>
        <input type="date" id="inline-c-date" class="date-input" style="height:24px; font-size:10px; max-width:105px;">
      </div>

      <div style="display:flex; align-items:center; gap:4px;">
        <button class="creator-pin-btn ${inlineCreatorPinnedState ? 'active' : ''}" id="inline-c-pin-btn" style="font-size:14px; padding:2px;" onclick="toggleInlineCreatorPin(event)" title="Pin to Execute Now">${inlineCreatorPinnedState ? '📌' : '📍'}</button>

        <div style="position:relative; display:inline-flex;">
          <button class="dots-btn" style="width:22px; height:22px; font-size:14px;" onclick="toggleModalDropdown(event, 'inline-c-menu')">⋮</button>
          <div class="dropdown-menu" id="inline-c-menu">
            <button class="dropdown-item-btn" onclick="uncheckAllInlineCreatorItems(event)">🔲 Uncheck All Items</button>
            <button class="dropdown-item-btn" onclick="deleteCheckedInlineCreatorItems(event)">🗑️ Delete Checked Items</button>
            <button class="dropdown-item-btn delete-action" onclick="discardInlineCreatorNote(event)">🗑️ Discard Note</button>
          </div>
        </div>

        <button class="btn" style="padding:2px 10px; font-size:11px; height:26px;" onclick="saveAndCloseInlineCreator(event)">Save</button>
      </div>
    </div>

    <div class="modal-selected-labels-bar" id="inline-c-selected-labels-bar"></div>

    <input type="text" id="inline-c-title" class="card-edit-title-input" placeholder="Title">
    <textarea id="inline-c-text" class="card-edit-textarea" placeholder="Note details... (Click '☑️' for checklist)" style="display:${isChecklist ? 'none' : 'block'};" oninput="autoScaleTextarea(this)"></textarea>
    <div id="inline-c-checklist-container" style="display:${isChecklist ? 'flex' : 'none'}; flex-direction:column; gap:4px; margin-top:4px;"></div>
  `;

  setTimeout(() => {
    renderInlineCreatorSelectedLabelsBar();
    const tArea = document.getElementById('inline-c-text');
    if (tArea) {
      autoScaleTextarea(tArea);
      bindKeepCheckboxInputInterceptor(tArea);
    }
    if (isChecklist) {
      renderInlineCreatorChecklistUI();
    }
  }, 10);

  return container;
}

const AUTO_CARD_PALETTE = [
  '#fef7e0', // 1. Soft Amber / Yellow
  '#e8f0fe', // 2. Soft Periwinkle Blue
  '#e6f4ea', // 3. Soft Mint Green
  '#fce8e6', // 4. Soft Rose / Coral
  '#f3e8fd', // 5. Soft Lavender
  '#e4f7fb', // 6. Soft Cyan / Sky
  '#feefe3', // 7. Soft Peach
  '#fde7f3', // 8. Soft Pink
  '#eef3fc', // 9. Soft Ice Indigo
  '#f1f8e9', // 10. Soft Sage
  '#fff8e1', // 11. Warm Cream
  '#e0f2f1'  // 12. Soft Teal
];

function getUniqueCardColor(note, cardIndex = 0) {
  // Uses the card's position (cardIndex) within its section so consecutive cards
  // under the same label or timeline section always get distinct colors.
  // Also offsets slightly by note.id so colors feel naturally varied across sections.
  let idOffset = 0;
  if (note && note.id) {
    for (let i = 0; i < note.id.length; i++) {
      idOffset += note.id.charCodeAt(i);
    }
  }
  const colorIndex = (cardIndex + (idOffset % 3)) % AUTO_CARD_PALETTE.length;
  return AUTO_CARD_PALETTE[colorIndex];
}

function createNoteCardDOM(note, allUniqueLabels, cardIndex = 0) {
  const isEditingThisCard = (activeInlineEditingNoteId === note.id);
  const isExpandedView = (currentlyExpandedNoteId === note.id);
  const card = document.createElement('div'); 
  card.id = `note-card-${note.id}`;

  if (isEditingThisCard) {
    card.className = `note-card in-card-editing-mode ${inCardPinnedState ? 'execute-now-card' : ''}`;
    card.style.backgroundColor = getUniqueCardColor(note, cardIndex);

    const rawText = note.text || '';
    const isChecklist = inCardChecklistLines.length > 0 || rawText.includes('[ ]') || rawText.includes('[x]');

    card.innerHTML = `
      <div class="card-edit-toolbar" onclick="event.stopPropagation();">
        <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
          <div style="position:relative; display:inline-block;">
            <button class="icon-picker-btn" style="height:26px; min-width:28px; padding:2px 6px; font-size:12px;" onclick="toggleInCardCheckboxMenu(event, '${note.id}')" title="Assign Labels">🏷️</button>
            <div class="checkbox-dropdown-menu" id="in-card-label-menu-${note.id}" onclick="event.stopPropagation();">
              <div class="popover-header-fixed">
                <div class="popover-section-title">Label note</div>
                <div class="popover-input-wrapper">
                  <input type="text" id="in-label-search-${note.id}" class="label-input" placeholder="Enter label name" oninput="renderInCardLabelsDropdown('${note.id}', this.value)">
                  <span class="search-icon">🔍</span>
                </div>
              </div>
              <div class="popover-scroll-body" id="in-label-scroll-${note.id}"></div>
            </div>
          </div>

          <button class="icon-picker-btn" style="height:26px; min-width:28px; padding:2px 6px; font-size:12px;" onclick="toggleInCardNumberedListFormat(event, '${note.id}')" title="Format as 1.2.3 list">🔢</button>
          <button class="icon-picker-btn" style="height:26px; min-width:28px; padding:2px 6px; font-size:12px;" onclick="toggleInCardChecklistFormat(event, '${note.id}')" title="Format as checkboxes">☑️</button>
          <button class="strict-toggle-btn-ui ${inCardStrictState ? 'active' : ''}" style="height:26px; width:28px; padding:2px; font-size:12px;" id="in-strict-btn-${note.id}" onclick="toggleInCardStrictState(event, '${note.id}')" title="Toggle Hard Deadline">🚨</button>
        </div>

        <div style="display:flex; align-items:center; gap:6px;">
          <button class="btn" style="padding:4px 10px; font-size:11px; height:26px; background:#5f6368;" onclick="cancelInCardEditing(event, '${note.id}')">Cancel</button>
          <button class="btn" style="padding:4px 10px; font-size:11px; height:26px;" onclick="saveInCardNoteDirect('${note.id}')">Save</button>
        </div>
      </div>

      <div class="modal-selected-labels-bar" id="in-selected-labels-${note.id}"></div>

      <input type="text" id="in-title-${note.id}" class="card-edit-title-input" placeholder="Title" value="${(note.title || '').replace(/"/g, '&quot;')}">
      <textarea id="in-text-${note.id}" class="card-edit-textarea" placeholder="Note details..." style="display:${isChecklist ? 'none' : 'block'};" oninput="autoScaleTextarea(this)">${note.text || ''}</textarea>
      <div id="in-checklist-container-${note.id}" style="display:${isChecklist ? 'flex' : 'none'}; flex-direction:column; gap:4px; margin-top:4px;"></div>
    `;

    setTimeout(() => {
      renderInCardSelectedLabelsBar(note.id);
      const tArea = document.getElementById(`in-text-${note.id}`);
      if (tArea) {
        autoScaleTextarea(tArea);
        bindKeepCheckboxInputInterceptor(tArea);
      }
      if (isChecklist) {
        renderInCardChecklistUI(note.id);
      }
    }, 10);

    return card;
  }

  // Read Card
  card.className = `note-card ${note.pinned ? 'execute-now-card' : ''}`; 
  card.style.backgroundColor = getUniqueCardColor(note, cardIndex);
  card.setAttribute('onclick', `startInCardEditing(event, '${note.id}')`);
  
 let isPast = false;
  let dateDisplaySummary = "(set date)";
  let dateColorModifiersClass = "no-date";
  let deadlineCountdownBadgeHTML = "";
  
  if (note.dueDate) {
    const parts = note.dueDate.split('-');
    if (parts.length === 3) {
      const dTarget = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
      dTarget.setHours(0, 0, 0, 0);
      const dNow = new Date();
      dNow.setHours(0, 0, 0, 0);
      const diffDays = Math.round((dTarget.getTime() - dNow.getTime()) / (1000 * 60 * 60 * 24));
      isPast = diffDays < 0;

      if (diffDays < 0) {
        deadlineCountdownBadgeHTML = `<div class="deadline-countdown-badge overdue">⚠️ Overdue</div>`;
      } else if (diffDays === 0) {
        deadlineCountdownBadgeHTML = `<div class="deadline-countdown-badge">🚨 Due Today</div>`;
      } else if (diffDays === 1) {
        deadlineCountdownBadgeHTML = `<div class="deadline-countdown-badge">⏳ Due Tomorrow</div>`;
      } else {
        deadlineCountdownBadgeHTML = `<div class="deadline-countdown-badge soft-safe">⏳ ${diffDays} Days Left</div>`;
      }

      dateDisplaySummary = `${dTarget.getDate()} ${dTarget.toLocaleDateString('en-US', { month: 'short' })}, ${dTarget.toLocaleDateString('en-US', { weekday: 'short' })}`;
      dateColorModifiersClass = isPast ? "past-due" : "";
    }
  }

  const elapsedDays = calculateElapsedDays(note.createdAt);
  const dayText = elapsedDays === 1 ? '1 day ago' : `${elapsedDays} days ago`;
  const elapsedBadgeHTML = `<div class="deadline-countdown-badge elapsed-days" title="Created ${dayText}">⌛ ${elapsedDays === 0 ? 'Today' : dayText}</div>`;

  const interactiveDateTagHTML = `
    <div style="position:relative; display:inline-flex;">
      <div class="interactive-date-trigger-tag ${dateColorModifiersClass}" onclick="toggleCardDatePopoverDirect(event,'${note.id}')">⏰ ${dateDisplaySummary}</div>
      <div class="custom-date-popover-menu" id="read-card-date-menu-${note.id}">
        <input type="date" id="popover-date-input-${note.id}" class="popover-date-field" value="${note.dueDate||''}">
        <div class="popover-date-btn-row">
          <button class="popover-date-btn" onclick="clearPopoverDateDirect(event,'${note.id}')">Clear</button>
          <button class="popover-date-btn" style="background:#1a73e8; color:white;" onclick="savePopoverDateDirect(event,'${note.id}')">Save</button>
        </div>
      </div>
    </div>
  `;

  let topMetadataOrderedHTML = "";
  if (deadlineCountdownBadgeHTML) {
    topMetadataOrderedHTML = `${deadlineCountdownBadgeHTML} ${interactiveDateTagHTML} ${elapsedBadgeHTML}`;
  } else {
    topMetadataOrderedHTML = `${interactiveDateTagHTML} ${elapsedBadgeHTML}`;
  }

  let bodyContentHTML = "";
  let textStr = note.text || "";
  let textLines = parseTextToLines(textStr);
  let isChecklistFormat = textStr.includes('[ ]') || textStr.includes('[x]') || textStr.includes('[X]');
  const hasBodyContent = textLines.length > 0;
  
  if (isChecklistFormat && hasBodyContent) {
    bodyContentHTML = `<div class="inline-todo-container">`;
    let uncheckedItemsHTML = "";
    let checkedItemsHTML = "";
    let checkedCount = 0;

    textLines.forEach((line, index) => {
      let isChecked = line.startsWith('[x] ') || line.startsWith('[X] ');
      let cleaned = line.replace(/^\[[ xX]\]\s*/, '');
      let linkifiedCleaned = linkifyText(cleaned);

      let rowHTML = `
        <div class="inline-todo-row" onclick="event.stopPropagation();">
          <input type="checkbox" class="inline-todo-input-check" ${isChecked ? 'checked' : ''} 
                 onchange="toggleKeepItemStateInline(event, '${note.id}', ${index})">
          <span class="inline-todo-label-text ${isChecked ? 'checked-item-style' : ''}">${linkifiedCleaned}</span>
          <button class="pop-out-note-btn" title="Convert to Independent Note" onclick="convertChecklistItemToNewNote(event, '${note.id}', ${index})">⏏️</button>
        </div>
      `;

      if (isChecked) {
        checkedCount++;
        checkedItemsHTML += rowHTML;
      } else {
        uncheckedItemsHTML += rowHTML;
      }
    });

    bodyContentHTML += uncheckedItemsHTML;

    if (checkedCount > 0) {
      const collapseKey = `view-${note.id}`;
      const isExpanded = completedListsCollapsedState[collapseKey] || false;
      const arrow = isExpanded ? '▼' : '▶';
      const displayStyle = isExpanded ? 'flex' : 'none';

      bodyContentHTML += `
        <div class="completed-divider-bar" onclick="toggleCompletedTasksCollapse(event, '${collapseKey}')">
          <span id="completed-arrow-${collapseKey}" style="margin-right: 4px; font-size: 10px;">${arrow}</span>
          <span>${checkedCount} completed ${checkedCount === 1 ? 'item' : 'items'}</span>
        </div>
        <div class="completed-items-wrapper" id="completed-items-${collapseKey}" style="display: ${displayStyle};">
          ${checkedItemsHTML}
        </div>
      `;
    }

    bodyContentHTML += `</div>`;
  } else if (hasBodyContent) {
    bodyContentHTML = `<div class="note-card-text">${linkifyText(note.text)}</div>`;
  }
  
  let labelsArray = note.labels || [];
  let rawLabelInputString = labelsArray.join(', ');
  let chips = labelsArray.map(l => `<div class="individual-tag-chip" onclick="toggleCardCheckboxMenuDirect(event,'${note.id}')">🏷️ ${l}</div>`).join('') || `<div class="individual-tag-chip add-blank-chip" onclick="toggleCardCheckboxMenuDirect(event,'${note.id}')">🏷️ + Label</div>`;
  
  let cardCheckboxesHTML = "";
  allUniqueLabels.forEach(l => {
    const isChecked = labelsArray.includes(l) ? 'checked' : '';
    cardCheckboxesHTML += `
      <label class="checkbox-item" onclick="event.stopPropagation();">
        <input type="checkbox" value="${l}" ${isChecked} onchange="handleGridCheckboxToggle(event, '${note.id}', this.value, this.checked, 'read-label-in-${note.id}')">
        <span>${l}</span>
      </label>
    `;
  });

  let expandButtonHTML = "";
  if (hasBodyContent) {
    expandButtonHTML = `
      <button class="card-expand-toggle-btn" onclick="toggleNoteCardExpand(event, '${note.id}')" title="${isExpandedView ? 'Collapse details' : 'Expand details'}">
        <span>${isExpandedView ? '▼' : '▶'}</span>
      </button>
    `;
  }

  const isEligibleToDemote = !hasBodyContent;

  card.innerHTML = `
    <button class="pin-btn" onclick="togglePinDirect(event, '${note.id}', ${note.pinned})" title="${note.pinned ? 'Unmark from Execute Now' : 'Mark to Execute Now'}">${note.pinned?'📌':'📍'}</button>

    <div class="menu-container" onclick="event.stopPropagation();">
      <button class="dots-btn" onclick="toggleDropdown(event, '${note.id}')">⋮</button>
      <div class="dropdown-menu" id="menu-${note.id}">
        ${isChecklistFormat ? `

          <button class="dropdown-item-btn" onclick="uncheckAllItemsDirect(event, '${note.id}')">🔲 Uncheck all items</button>
          <button class="dropdown-item-btn" onclick="deleteCheckedItemsDirect(event, '${note.id}')">🗑️ Delete checked items</button>
        ` : ''}

        ${isEligibleToDemote ? `
          <button class="dropdown-item-btn" onclick="openMoveNoteTargetPicker(event, '${note.id}')">⤵ Move to Note as item</button>
        ` : ''}

        <button class="dropdown-item-btn delete-action" onclick="deleteNoteDirect(event, '${note.id}')">🗑️ Delete Note</button>
      </div>
    </div>

    <!-- LINE 1: Dates, Flags, Labels -->
    <div class="card-top-metadata-row" onclick="event.stopPropagation();">
      ${topMetadataOrderedHTML}

      <div style="position:relative; display:inline-flex;">
        <div style="display:inline-flex; flex-wrap:wrap; gap:4px;">${chips}</div>
        <div class="checkbox-dropdown-menu" id="read-card-checkbox-menu-popover-${note.id}">
          <div class="popover-header-fixed">
            <div class="popover-section-title">Label note</div>
            <div class="popover-input-wrapper">
              <input type="text" id="read-label-in-${note.id}" value="${rawLabelInputString}" placeholder="Enter label name" onchange="handleGridManualLabelSave(event,'${note.id}')">
              <span class="search-icon">🔍</span>
            </div>
          </div>
          <div class="popover-scroll-body">
            ${cardCheckboxesHTML}
          </div>
        </div>
      </div>
    </div>
    
    <!-- LINE 2: Task Title and Expand/Collapse Toggle Button -->
    <div class="note-card-title-row">
      <div class="note-card-title">${note.title || 'Untitled'}</div>
      ${expandButtonHTML}
    </div>

    <!-- COLLAPSIBLE BODY DETAILS -->
    <div class="card-collapsible-body-wrapper ${isExpandedView ? 'expanded' : ''}" onclick="event.stopPropagation();">
      ${bodyContentHTML}
    </div>
  `;
  return card;
}

function renderSectionMasonryGrid(cardsArray, colsCount, allUniqueLabels, isCollapsed) {
  const containerEl = document.createElement('div');
  containerEl.className = `notes-container ${isCollapsed ? 'collapsed' : ''}`;

  const colElements = [];
  const colHeights = new Array(colsCount).fill(0);

  for (let i = 0; i < colsCount; i++) {
    const col = document.createElement('div');
    col.className = "masonry-column";
    containerEl.appendChild(col);
    colElements.push(col);
  }

  cardsArray.forEach((note, idx) => {
    const cardDOM = createNoteCardDOM(note, allUniqueLabels, idx);

    if (colsCount === 1) {
      colElements[0].appendChild(cardDOM);
    } else {
      let targetColIdx = 0;
      let minHeight = colHeights[0];

      for (let c = 1; c < colsCount; c++) {
        if (colHeights[c] < minHeight) {
          minHeight = colHeights[c];
          targetColIdx = c;
        }
      }

      colElements[targetColIdx].appendChild(cardDOM);

      const textLength = (note.text || '').length + (note.title || '').length;
      const estimatedCardHeight = 120 + Math.min(Math.floor(textLength / 2.5), 350);
      colHeights[targetColIdx] += estimatedCardHeight;
    }
  });

  return containerEl;
}

function renderNotes() {
  const workspaceTarget = document.getElementById('workspace-target');
  if (!workspaceTarget) return;
  
  workspaceTarget.innerHTML = '';
  
  try {
    const isTrackerMode = (currentWorkspaceViewMode === 'TRACKER');

    if (isTrackerMode) {
      workspaceTarget.appendChild(createInlineTrackerCreatorDOM());
      const trackerDashboardDiv = document.createElement('div');
      trackerDashboardDiv.id = 'habits-dashboard-target';
      trackerDashboardDiv.style.width = '100%';
      workspaceTarget.appendChild(trackerDashboardDiv);
      renderHabitsDashboard();
      return;
    }

    // Inline Note Creator for Unified Notes View
    workspaceTarget.appendChild(createInlineCreatorDOM());

    let fl = notes;
    if (currentLabelFilter === 'NONE') fl = fl.filter(n => !n.labels || n.labels.length === 0);
    else if (currentLabelFilter === 'NO_DATE') fl = fl.filter(n => !n.dueDate);
    else if (currentLabelFilter !== 'ALL') fl = fl.filter(n => n.labels && n.labels.includes(currentLabelFilter));
    
    const sortByDateThenCreated = (a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      if (!a.dueDate && b.dueDate) return 1;
      if (a.dueDate && !b.dueDate) return -1;
      if (a.dueDate && b.dueDate) {
        if (a.dueDate !== b.dueDate) return a.dueDate.localeCompare(b.dueDate);
      }
      return (b.createdAt || 0) - (a.createdAt || 0);
    };

    let colsCount = isSingleColumnView ? 1 : 3;
    if (!isSingleColumnView) {
      if (window.innerWidth <= 768) colsCount = 2;
      else if (window.innerWidth <= 1100) colsCount = 2;
    }

    const allUniqueLabels = getUniqueLabels();

    /* 1. CONDITIONAL TOP ANCHOR: PINNED NOTES */
    const pinned = fl.filter(n => n.pinned);
    const regular = fl;

    if (pinned.length > 0) {
      const pinnedCollapsed = timelineCollapsedState.pinned;
      const pinnedArrow = pinnedCollapsed ? '▶' : '▼';
      const pinnedTitle = document.createElement('div');
      pinnedTitle.className = "section-title execute-now-section-title";
      pinnedTitle.setAttribute('onclick', "toggleTimelineSectionCollapse('pinned')");
      pinnedTitle.innerHTML = `<span>📌 PINNED NOTES <span style="font-size: 9px; margin-left: 2px;">${pinnedArrow}</span></span> <span>(${pinned.length})</span>`;
      workspaceTarget.appendChild(pinnedTitle);

      pinned.sort(sortByDateThenCreated);
      const pinnedGrid = renderSectionMasonryGrid(pinned, colsCount, allUniqueLabels, pinnedCollapsed);
      workspaceTarget.appendChild(pinnedGrid);
    }

    /* Categorize Timeline Buckets */
    const overdueItems = [];
    const softDeadlineItems = [];
    const noDateItems = [];

    regular.forEach(n => {
      let isOverdue = false;
      if (n.dueDate) {
        const parts = n.dueDate.split('-');
        if (parts.length === 3) {
          const target = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
          target.setHours(0, 0, 0, 0);
          const now = new Date();
          now.setHours(0, 0, 0, 0);
          if (Math.round((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)) < 0) {
            isOverdue = true;
          }
        }
      }

      if (isOverdue) {
        overdueItems.push(n);
      } else if (n.dueDate) {
        softDeadlineItems.push(n);
      } else {
        noDateItems.push(n);
      }
    });

    /* 2. CONDITIONAL TOP SECTION: OVERDUE ITEMS */
    if (overdueItems.length > 0) {
      overdueItems.sort(sortByDateThenCreated);
      const isOverdueCollapsed = timelineCollapsedState.OVERDUE;
      const overdueArrow = isOverdueCollapsed ? '▶' : '▼';

      const overdueSecTitle = document.createElement('div');
      overdueSecTitle.className = "section-title overdue-section-title";
      overdueSecTitle.setAttribute('onclick', "toggleTimelineSectionCollapse('OVERDUE')");
      overdueSecTitle.innerHTML = `<span>🚨 OVERDUE ITEMS <span style="font-size: 9px; margin-left: 2px;">${overdueArrow}</span></span> <span>(${overdueItems.length})</span>`;
      workspaceTarget.appendChild(overdueSecTitle);

      workspaceTarget.appendChild(renderSectionMasonryGrid(overdueItems, colsCount, allUniqueLabels, isOverdueCollapsed));
    }

    /* 3. FIXED TOP SECTION: UPCOMING DEADLINES */
    softDeadlineItems.sort(sortByDateThenCreated);
    const isSoftDeadlineCollapsed = timelineCollapsedState.SOFT_DEADLINE;
    const softArrow = isSoftDeadlineCollapsed ? '▶' : '▼';

    const softSecTitle = document.createElement('div');
    softSecTitle.className = "section-title soft-deadline-section-title";
    softSecTitle.setAttribute('onclick', "toggleTimelineSectionCollapse('SOFT_DEADLINE')");
    softSecTitle.innerHTML = `<span>⏰ UPCOMING DEADLINES <span style="font-size: 9px; margin-left: 2px;">${softArrow}</span></span> <span>(${softDeadlineItems.length})</span>`;
    workspaceTarget.appendChild(softSecTitle);

    if (softDeadlineItems.length > 0) {
      workspaceTarget.appendChild(renderSectionMasonryGrid(softDeadlineItems, colsCount, allUniqueLabels, isSoftDeadlineCollapsed));
    } else {
      const emptyNotice = document.createElement('div');
      emptyNotice.className = isSoftDeadlineCollapsed ? 'notes-container collapsed' : 'notes-container';
      emptyNotice.style.cssText = "font-size:12px; color:#80868b; font-style:italic; padding:4px 0 12px 4px;";
      emptyNotice.innerText = "No tasks";
      workspaceTarget.appendChild(emptyNotice);
    }

    /* 4. MIDDLE DYNAMIC SECTIONS: PINNED LABELS -> OTHER LABELS -> NO LABEL */
    const pinnedRegistry = Array.isArray(pinnedLabelsRegistry) ? pinnedLabelsRegistry : [];
    const allLabelsList = Array.from(allUniqueLabels);

    const pinnedLabels = allLabelsList.filter(l => pinnedRegistry.includes(l)).sort((a,b) => a.localeCompare(b));
    const unpinnedLabels = allLabelsList.filter(l => !pinnedRegistry.includes(l)).sort((a,b) => a.localeCompare(b));
    const noLabelNotes = regular.filter(n => !n.labels || n.labels.length === 0);

    const renderSingleLabelLineSection = (labelName, isPinnedLabel, isNoLabel = false) => {
      const labelKey = isNoLabel ? '__NO_LABEL__' : labelName;
      if (labelLineCollapsedState[labelKey] === undefined) {
        labelLineCollapsedState[labelKey] = true;
      }
      const isCollapsed = labelLineCollapsedState[labelKey];
      const arrow = isCollapsed ? '▶' : '▼';

      let matchingNotes = isNoLabel
        ? noLabelNotes
        : regular.filter(n => n.labels && n.labels.includes(labelName));
      matchingNotes.sort(sortByDateThenCreated);

      const base64 = btoa(encodeURIComponent(labelName)).replace(/=/g, '');

      const secTitle = document.createElement('div');
      secTitle.className = `section-title ${isPinnedLabel ? 'label-pinned-section-title' : 'macro-section-title'}`;
      secTitle.setAttribute('onclick', `toggleLabelLineSectionCollapse('${labelKey.replace(/'/g, "\\'")}')`);

      let pinIconHTML = '';
      let dotsMenuHTML = '';

      if (!isNoLabel) {
        pinIconHTML = `<span class="sidebar-pin-toggle" onclick="event.stopPropagation(); toggleLabelSidebarPin(event, '${labelName.replace(/'/g, "\\'")}')" title="${isPinnedLabel ? 'Unpin Label Priority' : 'Pin Label to Top Priority'}">${isPinnedLabel ? '📌' : '📍'}</span>`;
        dotsMenuHTML = `
          <span class="sidebar-dots-trigger" onclick="toggleSidebarChipPopover(event, 'hdr-${base64}')" title="Label Actions">⋮</span>
          <div class="chip-popover-menu" id="chip-popover-hdr-${base64}" onclick="event.stopPropagation();">
            <div class="popover-header-fixed">
              <div class="popover-section-title">Edit Name</div>
              <input type="text" class="chip-inline-input" value="${labelName}" onchange="editLabelNameGlobal('${labelName.replace(/'/g, "\\'")}', this.value)">
            </div>
            <button class="chip-popover-btn delete-action" onclick="deleteLabelGlobal('${labelName.replace(/'/g, "\\'")}');">🗑️ Delete Label</button>
          </div>
        `;
      }

      const labelTitleDisplay = isNoLabel ? `⚪ NO LABEL` : `🏷️ ${labelName}`;

      secTitle.innerHTML = `
        <div style="display:flex; align-items:center; gap:6px;">
          ${pinIconHTML}
          <span>${labelTitleDisplay} <span style="font-size: 9px; margin-left: 2px;">${arrow}</span></span>
        </div>
        <span>(${matchingNotes.length})</span>
        ${dotsMenuHTML}
      `;
      workspaceTarget.appendChild(secTitle);

      if (matchingNotes.length > 0) {
        workspaceTarget.appendChild(renderSectionMasonryGrid(matchingNotes, colsCount, allUniqueLabels, isCollapsed));
      } else {
        const emptyNotice = document.createElement('div');
        emptyNotice.className = isCollapsed ? 'notes-container collapsed' : 'notes-container';
        emptyNotice.style.cssText = "font-size:12px; color:#80868b; font-style:italic; padding:4px 0 12px 12px;";
        emptyNotice.innerText = "No tasks";
        workspaceTarget.appendChild(emptyNotice);
      }
    };

    pinnedLabels.forEach(lbl => renderSingleLabelLineSection(lbl, true, false));
    unpinnedLabels.forEach(lbl => renderSingleLabelLineSection(lbl, false, false));
    renderSingleLabelLineSection('No Label', false, true);

    /* 5. FIXED BOTTOM SECTION: NO DATE (Placed just after No Label) */
    noDateItems.sort(sortByDateThenCreated);
    const isNoDateCollapsed = timelineCollapsedState.NO_DATE;
    const noDateArrow = isNoDateCollapsed ? '▶' : '▼';

    const noDateSecTitle = document.createElement('div');
    noDateSecTitle.className = "section-title macro-section-title";
    noDateSecTitle.setAttribute('onclick', "toggleTimelineSectionCollapse('NO_DATE')");
    noDateSecTitle.innerHTML = `<span>📥 NO DATE <span style="font-size: 9px; margin-left: 2px;">${noDateArrow}</span></span> <span>(${noDateItems.length})</span>`;
    workspaceTarget.appendChild(noDateSecTitle);

    if (noDateItems.length > 0) {
      workspaceTarget.appendChild(renderSectionMasonryGrid(noDateItems, colsCount, allUniqueLabels, isNoDateCollapsed));
    } else {
      const emptyNotice = document.createElement('div');
      emptyNotice.className = isNoDateCollapsed ? 'notes-container collapsed' : 'notes-container';
      emptyNotice.style.cssText = "font-size:12px; color:#80868b; font-style:italic; padding:4px 0 12px 4px;";
      emptyNotice.innerText = "No tasks";
      workspaceTarget.appendChild(emptyNotice);
    }

  } catch(err) {
    console.error("Critical Workspace Render Error: ", err);
  }
}

window.addEventListener('resize', () => renderNotes());
window.addEventListener('DOMContentLoaded', () => {
  updateHeaderViewModeButtons();
  document.addEventListener('wheel', (e) => {
    if (e.target.closest('.popover-scroll-body') || e.target.closest('.move-target-list')) {
      e.stopPropagation();
    }
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (e.target.closest('.popover-scroll-body') || e.target.closest('.move-target-list')) {
      e.stopPropagation();
    }
  }, { passive: true });
});