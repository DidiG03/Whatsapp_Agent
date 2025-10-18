/**
 * Contact Management Routes
 * Handles contact profiles, tags, search, and import/export
 */
import { ensureAuthed, getCurrentUserId } from "../middleware/auth.mjs";
import { renderSidebar, normalizePhone, escapeHtml, renderTopbar } from "../utils.mjs";
import { db } from "../db.mjs";
import {
  getContactProfile,
  upsertContactProfile,
  getContactsForUser,
  getContactStats,
  getContactTags,
  createContactTag,
  updateContactTag,
  deleteContactTag,
  addTagToContact,
  removeTagFromContact,
  recordContactInteraction,
  getContactInteractions,
  updateContactActivity,
  deleteContactProfile,
  exportContactsToCSV,
  importContactsFromCSV
} from "../services/contacts.mjs";
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configure multer for profile photo uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, '../../uploads/profile-photos');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'profile-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const uploadProfilePhoto = multer({ 
  storage: storage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only image files are allowed for profile photos!'));
    }
  }
});

export default function registerContactRoutes(app) {
  
  // Contact Management Dashboard
  app.get("/contacts", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const email = req.user?.email || 'user@example.com';
    
    // Get filters from query parameters
    const search = (req.query.search || "").toString().trim();
    const status = (req.query.status || "").toString().trim();
    const company = (req.query.company || "").toString().trim();
    const tags = req.query.tags ? req.query.tags.toString().split(',').filter(t => t.trim()) : [];
    const page = parseInt(req.query.page || '1');
    const limit = 20;
    const offset = (page - 1) * limit;

    const filters = { search, status, company, tags, limit, offset };
    
    // Get contacts and stats
    const contacts = getContactsForUser(userId, filters);
    const stats = getContactStats(userId);
    const availableTags = getContactTags(userId);
    
    // Get total count for pagination
    const totalContacts = getContactsForUser(userId, { ...filters, limit: 10000 }).length;
    const totalPages = Math.ceil(totalContacts / limit);

    res.setHeader("Content-Type", "text/html");
    res.end(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Contact Management - WhatsApp Agent</title>
        <link rel="stylesheet" href="/styles.css">
        <style>
          .contacts-container {
            display: flex;
            gap: 20px;
            margin: 20px;
          }
          
          .contacts-sidebar {
            width: 300px;
            background: white;
            border-radius: 12px;
            padding: 20px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
            height: fit-content;
          }
          
          .contacts-main {
            flex: 1;
            background: white;
            border-radius: 12px;
            padding: 20px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
          }
          
          .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
            gap: 15px;
            margin-bottom: 20px;
          }
          
          .stat-card {
            background: #f8fafc;
            padding: 15px;
            border-radius: 8px;
            text-align: center;
            border: 1px solid #e2e8f0;
          }
          
          .stat-number {
            font-size: 24px;
            font-weight: bold;
            color: #1e40af;
            margin-bottom: 5px;
          }
          
          .stat-label {
            font-size: 12px;
            color: #64748b;
            text-transform: uppercase;
            letter-spacing: 0.5px;
          }
          
          .filters-section {
            margin-bottom: 20px;
          }
          
          .filter-group {
            margin-bottom: 15px;
          }
          
          .filter-label {
            display: block;
            font-size: 14px;
            font-weight: 500;
            color: #374151;
            margin-bottom: 5px;
          }
          
          .filter-input {
            width: 100%;
            padding: 8px 12px;
            border: 1px solid #d1d5db;
            border-radius: 6px;
            font-size: 14px;
          }
          
          .filter-select {
            width: 100%;
            padding: 8px 12px;
            border: 1px solid #d1d5db;
            border-radius: 6px;
            font-size: 14px;
            background: white;
          }
          
          .tag-filters {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            margin-top: 8px;
          }
          
          .tag-filter {
            display: flex;
            align-items: center;
            gap: 5px;
            padding: 4px 8px;
            background: #f1f5f9;
            border-radius: 4px;
            font-size: 12px;
          }
          
          .tag-color {
            width: 12px;
            height: 12px;
            border-radius: 50%;
          }
          
          .contacts-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
            padding-bottom: 15px;
            border-bottom: 1px solid #e5e7eb;
          }
          
          .contacts-title {
            font-size: 24px;
            font-weight: bold;
            color: #111827;
          }
          
          .contacts-actions {
            display: flex;
            gap: 10px;
          }
          
          .btn {
            padding: 8px 16px;
            border-radius: 6px;
            font-size: 14px;
            font-weight: 500;
            text-decoration: none;
            border: none;
            cursor: pointer;
            transition: all 0.2s;
          }
          
          .btn-primary {
            background: #3b82f6;
            color: white;
          }
          
          .btn-primary:hover {
            background: #2563eb;
          }
          
          .btn-secondary {
            background: #6b7280;
            color: white;
          }
          
          .btn-secondary:hover {
            background: #4b5563;
          }
          
          .contacts-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
            gap: 20px;
          }
          
          .contact-card {
            background: white;
            border: 1px solid #e5e7eb;
            border-radius: 8px;
            padding: 16px;
            transition: all 0.2s;
            cursor: pointer;
          }
          
          .contact-card:hover {
            border-color: #3b82f6;
            box-shadow: 0 4px 12px rgba(59, 130, 246, 0.15);
          }
          
          .contact-header {
            display: flex;
            align-items: center;
            gap: 12px;
            margin-bottom: 12px;
          }
          
          .contact-avatar {
            width: 40px;
            height: 40px;
            border-radius: 50%;
            background: #e5e7eb;
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: bold;
            color: #6b7280;
            font-size: 16px;
          }
          
          .contact-info {
            flex: 1;
          }
          
          .contact-name {
            font-size: 16px;
            font-weight: 600;
            color: #111827;
            margin-bottom: 2px;
          }
          
          .contact-company {
            font-size: 14px;
            color: #6b7280;
          }
          
          .contact-details {
            margin-bottom: 12px;
          }
          
          .contact-detail {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 4px;
            font-size: 14px;
            color: #374151;
          }
          
          .contact-tags {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            margin-bottom: 12px;
          }
          
          .contact-tag {
            padding: 2px 8px;
            border-radius: 12px;
            font-size: 12px;
            font-weight: 500;
            color: white;
          }
          
          .contact-actions {
            display: flex;
            gap: 8px;
          }
          
          .btn-small {
            padding: 4px 8px;
            font-size: 12px;
            border-radius: 4px;
          }
          
          .pagination {
            display: flex;
            justify-content: center;
            align-items: center;
            gap: 10px;
            margin-top: 20px;
          }
          
          .pagination-btn {
            padding: 8px 12px;
            border: 1px solid #d1d5db;
            background: white;
            border-radius: 6px;
            text-decoration: none;
            color: #374151;
            font-size: 14px;
          }
          
          .pagination-btn:hover {
            background: #f9fafb;
          }
          
          .pagination-btn.disabled {
            opacity: 0.5;
            cursor: not-allowed;
          }
          
          .pagination-info {
            font-size: 14px;
            color: #6b7280;
          }
          
          @media (max-width: 768px) {
            .contacts-container {
              flex-direction: column;
              margin: 10px;
            }
            
            .contacts-sidebar {
              width: 100%;
            }
            
            .contacts-grid {
              grid-template-columns: 1fr;
            }
          }
        </style>
      </head>
      <body>
        ${renderTopbar(email)}
        <div class="contacts-container">
          ${renderSidebar()}
          
          <div class="contacts-sidebar">
            <h3 style="margin-bottom: 15px; color: #374151;">Statistics</h3>
            <div class="stats-grid">
              <div class="stat-card">
                <div class="stat-number">${stats.total_contacts}</div>
                <div class="stat-label">Total</div>
              </div>
              <div class="stat-card">
                <div class="stat-number">${stats.active_contacts}</div>
                <div class="stat-label">Active</div>
              </div>
              <div class="stat-card">
                <div class="stat-number">${stats.contacts_with_email}</div>
                <div class="stat-label">With Email</div>
              </div>
              <div class="stat-card">
                <div class="stat-number">${stats.contacts_with_company}</div>
                <div class="stat-label">Companies</div>
              </div>
            </div>
            
            <div class="filters-section">
              <h3 style="margin-bottom: 15px; color: #374151;">Filters</h3>
              
              <form method="GET" action="/contacts">
                <div class="filter-group">
                  <label class="filter-label">Search</label>
                  <input type="text" name="search" value="${escapeHtml(search)}" placeholder="Name, email, company..." class="filter-input">
                </div>
                
                <div class="filter-group">
                  <label class="filter-label">Status</label>
                  <select name="status" class="filter-select">
                    <option value="">All Statuses</option>
                    <option value="active" ${status === 'active' ? 'selected' : ''}>Active</option>
                    <option value="inactive" ${status === 'inactive' ? 'selected' : ''}>Inactive</option>
                    <option value="blocked" ${status === 'blocked' ? 'selected' : ''}>Blocked</option>
                  </select>
                </div>
                
                <div class="filter-group">
                  <label class="filter-label">Company</label>
                  <input type="text" name="company" value="${escapeHtml(company)}" placeholder="Company name..." class="filter-input">
                </div>
                
                <div class="filter-group">
                  <label class="filter-label">Tags</label>
                  <div class="tag-filters">
                    ${availableTags.map(tag => `
                      <label class="tag-filter">
                        <input type="checkbox" name="tags" value="${escapeHtml(tag.name)}" ${tags.includes(tag.name) ? 'checked' : ''}>
                        <span class="tag-color" style="background: ${escapeHtml(tag.color)}"></span>
                        <span>${escapeHtml(tag.name)}</span>
                      </label>
                    `).join('')}
                  </div>
                </div>
                
                <button type="submit" class="btn btn-primary" style="width: 100%; margin-top: 10px;">Apply Filters</button>
                <a href="/contacts" class="btn btn-secondary" style="width: 100%; margin-top: 8px; text-align: center; display: block;">Clear Filters</a>
              </form>
            </div>
          </div>
          
          <div class="contacts-main">            
            <div class="contacts-grid">
              ${contacts.map(contact => `
                <div class="contact-card" onclick="window.location.href='/contacts/${escapeHtml(contact.contact_id)}'">
                  <div class="contact-header">
                    <div class="contact-avatar" style="background: ${contact.profile_photo_url ? 'url(' + escapeHtml(contact.profile_photo_url) + ')' : '#e5e7eb'}; background-size: cover; background-position: center;">
                      ${!contact.profile_photo_url ? (contact.display_name || contact.contact_id).charAt(0).toUpperCase() : ''}
                    </div>
                    <div class="contact-info">
                      <div class="contact-name">${escapeHtml(contact.display_name || contact.contact_id)}</div>
                      ${contact.company ? `<div class="contact-company">${escapeHtml(contact.company)}</div>` : ''}
                    </div>
                  </div>
                  
                  <div class="contact-details">
                    ${contact.email ? `<div class="contact-detail">📧 ${escapeHtml(contact.email)}</div>` : ''}
                    ${contact.job_title ? `<div class="contact-detail">💼 ${escapeHtml(contact.job_title)}</div>` : ''}
                    <div class="contact-detail">📱 ${escapeHtml(contact.contact_id)}</div>
                    ${contact.city && contact.country ? `<div class="contact-detail">📍 ${escapeHtml(contact.city)}, ${escapeHtml(contact.country)}</div>` : ''}
                  </div>
                  
                  ${contact.tags && contact.tags.length > 0 ? `
                    <div class="contact-tags">
                      ${contact.tags.map(tag => {
                        const tagInfo = availableTags.find(t => t.name === tag);
                        return `<span class="contact-tag" style="background: ${tagInfo ? tagInfo.color : '#6b7280'}">${escapeHtml(tag)}</span>`;
                      }).join('')}
                    </div>
                  ` : ''}
                  
                  <div class="contact-actions">
                    <a href="/contacts/${escapeHtml(contact.contact_id)}" class="btn btn-primary btn-small">View</a>
                    <a href="/inbox/${escapeHtml(contact.contact_id)}" class="btn btn-secondary btn-small">Chat</a>
                    <span class="btn btn-secondary btn-small" style="background: ${contact.status === 'active' ? '#10b981' : contact.status === 'inactive' ? '#f59e0b' : '#ef4444'}; color: white;">
                      ${contact.status || 'active'}
                    </span>
                  </div>
                </div>
              `).join('')}
            </div>
            
            ${totalPages > 1 ? `
              <div class="pagination">
                <a href="/contacts?page=${page > 1 ? page - 1 : 1}&${new URLSearchParams(req.query).toString()}" 
                   class="pagination-btn ${page <= 1 ? 'disabled' : ''}">Previous</a>
                
                <span class="pagination-info">Page ${page} of ${totalPages}</span>
                
                <a href="/contacts?page=${page < totalPages ? page + 1 : totalPages}&${new URLSearchParams(req.query).toString()}" 
                   class="pagination-btn ${page >= totalPages ? 'disabled' : ''}">Next</a>
              </div>
            ` : ''}
          </div>
        </div>
      </body>
      </html>
    `);
  });

  // Individual Contact Profile Page
  app.get("/contacts/:contactId", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const contactId = req.params.contactId;
    const email = req.user?.email || 'user@example.com';
    
    const contact = getContactProfile(userId, contactId);
    if (!contact) {
      return res.status(404).send('Contact not found');
    }
    
    const interactions = getContactInteractions(userId, contactId);
    const availableTags = getContactTags(userId);
    
    res.setHeader("Content-Type", "text/html");
    res.end(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${escapeHtml(contact.display_name)} - Contact Profile</title>
        <link rel="stylesheet" href="/styles.css">
        <style>
          .contact-profile-container {
            display: flex;
            gap: 20px;
            margin: 20px;
          }
          
          .contact-profile-sidebar {
            width: 350px;
            background: white;
            border-radius: 12px;
            padding: 20px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
            height: fit-content;
          }
          
          .contact-profile-main {
            flex: 1;
            background: white;
            border-radius: 12px;
            padding: 20px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
          }
          
          .profile-header {
            text-align: center;
            margin-bottom: 20px;
            padding-bottom: 20px;
            border-bottom: 1px solid #e5e7eb;
          }
          
          .profile-avatar {
            width: 80px;
            height: 80px;
            border-radius: 50%;
            background: #e5e7eb;
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: bold;
            color: #6b7280;
            font-size: 32px;
            margin: 0 auto 15px;
          }
          
          .profile-name {
            font-size: 24px;
            font-weight: bold;
            color: #111827;
            margin-bottom: 5px;
          }
          
          .profile-company {
            font-size: 16px;
            color: #6b7280;
            margin-bottom: 10px;
          }
          
          .profile-status {
            display: inline-block;
            padding: 4px 12px;
            border-radius: 20px;
            font-size: 12px;
            font-weight: 500;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            background: ${contact.status === 'active' ? '#dcfce7' : contact.status === 'inactive' ? '#fef3c7' : '#fee2e2'};
            color: ${contact.status === 'active' ? '#166534' : contact.status === 'inactive' ? '#92400e' : '#991b1b'};
          }
          
          .profile-details {
            margin-bottom: 20px;
          }
          
          .detail-section {
            margin-bottom: 20px;
          }
          
          .detail-section h4 {
            font-size: 16px;
            font-weight: 600;
            color: #374151;
            margin-bottom: 10px;
            padding-bottom: 5px;
            border-bottom: 1px solid #e5e7eb;
          }
          
          .detail-item {
            display: flex;
            align-items: center;
            gap: 10px;
            margin-bottom: 8px;
            font-size: 14px;
            color: #374151;
          }
          
          .detail-label {
            font-weight: 500;
            min-width: 80px;
            color: #6b7280;
          }
          
          .detail-value {
            flex: 1;
          }
          
          .profile-tags {
            margin-bottom: 20px;
          }
          
          .tag-list {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
          }
          
          .profile-tag {
            padding: 4px 12px;
            border-radius: 16px;
            font-size: 12px;
            font-weight: 500;
            color: white;
          }
          
          .profile-actions {
            display: flex;
            flex-direction: column;
            gap: 10px;
          }
          
          .btn {
            padding: 10px 16px;
            border-radius: 6px;
            font-size: 14px;
            font-weight: 500;
            text-decoration: none;
            border: none;
            cursor: pointer;
            transition: all 0.2s;
            text-align: center;
          }
          
          .btn-primary {
            background: #3b82f6;
            color: white;
          }
          
          .btn-primary:hover {
            background: #2563eb;
          }
          
          .btn-secondary {
            background: #6b7280;
            color: white;
          }
          
          .btn-secondary:hover {
            background: #4b5563;
          }
          
          .btn-success {
            background: #10b981;
            color: white;
          }
          
          .btn-success:hover {
            background: #059669;
          }
          
          .interactions-section h3 {
            font-size: 20px;
            font-weight: bold;
            color: #111827;
            margin-bottom: 15px;
          }
          
          .interaction-item {
            background: #f9fafb;
            border: 1px solid #e5e7eb;
            border-radius: 8px;
            padding: 12px;
            margin-bottom: 10px;
          }
          
          .interaction-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 8px;
          }
          
          .interaction-type {
            font-size: 14px;
            font-weight: 500;
            color: #374151;
            text-transform: capitalize;
          }
          
          .interaction-time {
            font-size: 12px;
            color: #6b7280;
          }
          
          .interaction-data {
            font-size: 14px;
            color: #6b7280;
          }
          
          @media (max-width: 768px) {
            .contact-profile-container {
              flex-direction: column;
              margin: 10px;
            }
            
            .contact-profile-sidebar {
              width: 100%;
            }
          }
        </style>
      </head>
      <body>
        ${renderTopbar(email)}
        <div class="contact-profile-container">
          ${renderSidebar()}
          
          <div class="contact-profile-sidebar">
            <div class="profile-header">
              <div class="profile-avatar" style="background: ${contact.profile_photo_url ? 'url(' + escapeHtml(contact.profile_photo_url) + ')' : '#e5e7eb'}; background-size: cover; background-position: center;">
                ${!contact.profile_photo_url ? (contact.display_name || contact.contact_id).charAt(0).toUpperCase() : ''}
              </div>
              <div class="profile-name">${escapeHtml(contact.display_name || contact.contact_id)}</div>
              ${contact.company ? `<div class="profile-company">${escapeHtml(contact.company)}</div>` : ''}
              <div class="profile-status">${contact.status || 'active'}</div>
            </div>
            
            <div class="profile-details">
              <div class="detail-section">
                <h4>Contact Information</h4>
                <div class="detail-item">
                  <span class="detail-label">Phone:</span>
                  <span class="detail-value">${escapeHtml(contact.contact_id)}</span>
                </div>
                ${contact.phone_alternative ? `
                  <div class="detail-item">
                    <span class="detail-label">Alt Phone:</span>
                    <span class="detail-value">${escapeHtml(contact.phone_alternative)}</span>
                  </div>
                ` : ''}
                ${contact.email ? `
                  <div class="detail-item">
                    <span class="detail-label">Email:</span>
                    <span class="detail-value">${escapeHtml(contact.email)}</span>
                  </div>
                ` : ''}
                ${contact.website ? `
                  <div class="detail-item">
                    <span class="detail-label">Website:</span>
                    <span class="detail-value"><a href="${escapeHtml(contact.website)}" target="_blank">${escapeHtml(contact.website)}</a></span>
                  </div>
                ` : ''}
              </div>
              
              ${contact.company || contact.job_title ? `
                <div class="detail-section">
                  <h4>Professional</h4>
                  ${contact.job_title ? `
                    <div class="detail-item">
                      <span class="detail-label">Title:</span>
                      <span class="detail-value">${escapeHtml(contact.job_title)}</span>
                    </div>
                  ` : ''}
                  ${contact.company ? `
                    <div class="detail-item">
                      <span class="detail-label">Company:</span>
                      <span class="detail-value">${escapeHtml(contact.company)}</span>
                    </div>
                  ` : ''}
                </div>
              ` : ''}
              
              ${contact.address || contact.city || contact.country ? `
                <div class="detail-section">
                  <h4>Address</h4>
                  ${contact.address ? `
                    <div class="detail-item">
                      <span class="detail-label">Address:</span>
                      <span class="detail-value">${escapeHtml(contact.address)}</span>
                    </div>
                  ` : ''}
                  ${contact.city || contact.country ? `
                    <div class="detail-item">
                      <span class="detail-label">Location:</span>
                      <span class="detail-value">${[contact.city, contact.state, contact.country].filter(Boolean).join(', ')}</span>
                    </div>
                  ` : ''}
                  ${contact.postal_code ? `
                    <div class="detail-item">
                      <span class="detail-label">Postal Code:</span>
                      <span class="detail-value">${escapeHtml(contact.postal_code)}</span>
                    </div>
                  ` : ''}
                </div>
              ` : ''}
              
              ${contact.tags && contact.tags.length > 0 ? `
                <div class="profile-tags">
                  <h4>Tags</h4>
                  <div class="tag-list">
                    ${contact.tags.map(tag => {
                      const tagInfo = availableTags.find(t => t.name === tag);
                      return `<span class="profile-tag" style="background: ${tagInfo ? tagInfo.color : '#6b7280'}">${escapeHtml(tag)}</span>`;
                    }).join('')}
                  </div>
                </div>
              ` : ''}
              
              ${contact.notes ? `
                <div class="detail-section">
                  <h4>Notes</h4>
                  <div style="background: #f9fafb; padding: 12px; border-radius: 6px; font-size: 14px; color: #374151; white-space: pre-wrap;">${escapeHtml(contact.notes)}</div>
                </div>
              ` : ''}
            </div>
            
            <div class="profile-actions">
              <a href="/inbox/${escapeHtml(contact.contact_id)}" class="btn btn-success">Start Chat</a>
              <a href="/contacts/${escapeHtml(contact.contact_id)}/edit" class="btn btn-primary">Edit Profile</a>
              <a href="/contacts" class="btn btn-secondary">Back to Contacts</a>
            </div>
          </div>
          
          <div class="contact-profile-main">
            <div class="interactions-section">
              <h3>Recent Interactions</h3>
              ${interactions.length > 0 ? interactions.map(interaction => `
                <div class="interaction-item">
                  <div class="interaction-header">
                    <span class="interaction-type">${escapeHtml(interaction.interaction_type)}</span>
                    <span class="interaction-time">${new Date(interaction.created_at * 1000).toLocaleString()}</span>
                  </div>
                  <div class="interaction-data">
                    ${interaction.interaction_data && typeof interaction.interaction_data === 'object' 
                      ? JSON.stringify(interaction.interaction_data, null, 2)
                      : escapeHtml(interaction.interaction_data || '')}
                  </div>
                </div>
              `).join('') : '<p style="color: #6b7280; font-style: italic;">No interactions recorded yet.</p>'}
            </div>
          </div>
        </div>
      </body>
      </html>
    `);
  });

  // API Routes for contact management
  app.post("/api/contacts", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const contactData = req.body;
    
    try {
      const result = upsertContactProfile(userId, contactData.contact_id, contactData);
      res.json({ success: true, contact: getContactProfile(userId, contactData.contact_id) });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  app.get("/api/contacts/:contactId", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const contactId = req.params.contactId;
    
    const contact = getContactProfile(userId, contactId);
    if (!contact) {
      return res.status(404).json({ success: false, error: 'Contact not found' });
    }
    
    res.json({ success: true, contact });
  });

  app.delete("/api/contacts/:contactId", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const contactId = req.params.contactId;
    
    try {
      deleteContactProfile(userId, contactId);
      res.json({ success: true });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  // Contact Tags API
  app.get("/api/contacts/tags", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const tags = getContactTags(userId);
    res.json({ success: true, tags });
  });

  app.post("/api/contacts/tags", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const tagData = req.body;
    
    try {
      const result = createContactTag(userId, tagData);
      res.json({ success: true, tag: { id: result.lastInsertRowid, ...tagData } });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  app.put("/api/contacts/tags/:tagId", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const tagId = req.params.tagId;
    const tagData = req.body;
    
    try {
      updateContactTag(userId, tagId, tagData);
      res.json({ success: true });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  app.delete("/api/contacts/tags/:tagId", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const tagId = req.params.tagId;
    
    try {
      deleteContactTag(userId, tagId);
      res.json({ success: true });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  // Add/Remove tag from contact
  app.post("/api/contacts/:contactId/tags", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const contactId = req.params.contactId;
    const { tagName } = req.body;
    
    try {
      addTagToContact(userId, contactId, tagName);
      res.json({ success: true });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  app.delete("/api/contacts/:contactId/tags/:tagName", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const contactId = req.params.contactId;
    const tagName = req.params.tagName;
    
    try {
      removeTagFromContact(userId, contactId, tagName);
      res.json({ success: true });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  // Export contacts
  app.get("/contacts/export", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const filters = req.query;
    
    try {
      const csvData = exportContactsToCSV(userId, filters);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="contacts.csv"');
      res.send(csvData);
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  // Import contacts
  app.get("/contacts/import", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const email = req.user?.email || 'user@example.com';
    
    res.setHeader("Content-Type", "text/html");
    res.end(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Import Contacts - WhatsApp Agent</title>
        <link rel="stylesheet" href="/styles.css">
      </head>
      <body>
        ${renderTopbar(email)}
        <div style="max-width: 800px; margin: 20px auto; background: white; border-radius: 12px; padding: 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
          <h1>Import Contacts</h1>
          <p>Upload a CSV file to import contacts. The CSV should have columns like: contact_id, display_name, first_name, last_name, email, company, etc.</p>
          
          <form action="/contacts/import" method="POST" enctype="multipart/form-data" style="margin-top: 20px;">
            <div style="margin-bottom: 15px;">
              <label style="display: block; margin-bottom: 5px; font-weight: 500;">CSV File:</label>
              <input type="file" name="csvFile" accept=".csv" required style="width: 100%; padding: 8px; border: 1px solid #d1d5db; border-radius: 6px;">
            </div>
            
            <button type="submit" style="background: #3b82f6; color: white; padding: 10px 20px; border: none; border-radius: 6px; cursor: pointer;">Import Contacts</button>
            <a href="/contacts" style="margin-left: 10px; color: #6b7280; text-decoration: none;">Cancel</a>
          </form>
        </div>
      </body>
      </html>
    `);
  });

  app.post("/contacts/import", ensureAuthed, uploadProfilePhoto.single('csvFile'), async (req, res) => {
    const userId = getCurrentUserId(req);
    
    if (!req.file) {
      return res.status(400).send('No CSV file uploaded');
    }
    
    try {
      const csvData = fs.readFileSync(req.file.path, 'utf8');
      const importedContacts = importContactsFromCSV(userId, csvData);
      
      // Clean up uploaded file
      fs.unlinkSync(req.file.path);
      
      res.redirect(`/contacts?toast=${encodeURIComponent(`Successfully imported ${importedContacts.length} contacts`)}&type=success`);
    } catch (error) {
      res.status(400).send(`Import failed: ${error.message}`);
    }
  });
}
