/**
 * Enhanced Contact Management Service
 * Handles contact profiles, tags, search, and analytics
 */
import { db } from "../db-serverless.mjs";

/**
 * Get contact profile by user_id and contact_id
 */
export function getContactProfile(userId, contactId) {
  const contact = db.prepare(`
    SELECT * FROM customers 
    WHERE user_id = ? AND contact_id = ?
  `).get(userId, contactId);
  
  if (!contact) return null;
  
  // Parse JSON fields
  try {
    contact.tags = contact.tags ? JSON.parse(contact.tags) : [];
    contact.social_media = contact.social_media ? JSON.parse(contact.social_media) : {};
    contact.custom_fields = contact.custom_fields ? JSON.parse(contact.custom_fields) : {};
  } catch (e) {
    contact.tags = [];
    contact.social_media = {};
    contact.custom_fields = {};
  }
  
  return contact;
}

/**
 * Create or update contact profile
 */
export function upsertContactProfile(userId, contactId, profileData) {
  const {
    display_name,
    first_name,
    last_name,
    email,
    company,
    job_title,
    notes,
    profile_photo_url,
    phone_alternative,
    address,
    city,
    state,
    country,
    postal_code,
    website,
    social_media,
    custom_fields,
    tags,
    status = 'active',
    source = 'manual'
  } = profileData;

  // Ensure display_name is set
  const finalDisplayName = display_name || 
    (first_name && last_name ? `${first_name} ${last_name}` : first_name || last_name || contactId);

  return db.prepare(`
    INSERT INTO customers (
      user_id, contact_id, display_name, first_name, last_name, email,
      company, job_title, notes, profile_photo_url, phone_alternative,
      address, city, state, country, postal_code, website,
      social_media, custom_fields, tags, status, source,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%s','now'), strftime('%s','now'))
    ON CONFLICT(user_id, contact_id) DO UPDATE SET
      display_name = excluded.display_name,
      first_name = excluded.first_name,
      last_name = excluded.last_name,
      email = excluded.email,
      company = excluded.company,
      job_title = excluded.job_title,
      notes = excluded.notes,
      profile_photo_url = excluded.profile_photo_url,
      phone_alternative = excluded.phone_alternative,
      address = excluded.address,
      city = excluded.city,
      state = excluded.state,
      country = excluded.country,
      postal_code = excluded.postal_code,
      website = excluded.website,
      social_media = excluded.social_media,
      custom_fields = excluded.custom_fields,
      tags = excluded.tags,
      status = excluded.status,
      source = excluded.source,
      updated_at = strftime('%s','now')
  `).run(
    userId, contactId, finalDisplayName, first_name, last_name, email,
    company, job_title, notes, profile_photo_url, phone_alternative,
    address, city, state, country, postal_code, website,
    JSON.stringify(social_media || {}), JSON.stringify(custom_fields || {}), JSON.stringify(tags || []),
    status, source
  );
}

/**
 * Get all contacts for a user with optional filtering
 */
export function getContactsForUser(userId, filters = {}) {
  const {
    search,
    tags,
    status,
    company,
    limit = 50,
    offset = 0
  } = filters;

  let whereConditions = ['c.user_id = ?'];
  let params = [userId];

  if (search) {
    whereConditions.push(`(
      c.display_name LIKE ? OR 
      c.first_name LIKE ? OR 
      c.last_name LIKE ? OR 
      c.email LIKE ? OR 
      c.company LIKE ? OR 
      c.notes LIKE ?
    )`);
    const searchTerm = `%${search}%`;
    params.push(searchTerm, searchTerm, searchTerm, searchTerm, searchTerm, searchTerm);
  }

  if (tags && tags.length > 0) {
    whereConditions.push(`c.tags LIKE ?`);
    params.push(`%"${tags[0]}"%`);
  }

  if (status) {
    whereConditions.push(`c.status = ?`);
    params.push(status);
  }

  if (company) {
    whereConditions.push(`c.company LIKE ?`);
    params.push(`%${company}%`);
  }

  const whereClause = whereConditions.join(' AND ');
  
  const contacts = db.prepare(`
    SELECT c.*, 
           (SELECT COUNT(*) FROM messages m 
            WHERE (m.from_id = c.contact_id OR m.to_id = c.contact_id) 
            AND m.user_id = ?) as message_count,
           (SELECT MAX(timestamp) FROM messages m 
            WHERE (m.from_id = c.contact_id OR m.to_id = c.contact_id) 
            AND m.user_id = ?) as last_message_time
    FROM customers c
    WHERE ${whereClause}
    ORDER BY c.updated_at DESC
    LIMIT ? OFFSET ?
  `).all(userId, userId, ...params, limit, offset);

  // Parse JSON fields for each contact
  return contacts.map(contact => {
    try {
      contact.tags = contact.tags ? JSON.parse(contact.tags) : [];
      contact.social_media = contact.social_media ? JSON.parse(contact.social_media) : {};
      contact.custom_fields = contact.custom_fields ? JSON.parse(contact.custom_fields) : {};
    } catch (e) {
      contact.tags = [];
      contact.social_media = {};
      contact.custom_fields = {};
    }
    return contact;
  });
}

/**
 * Get contact statistics
 */
export function getContactStats(userId) {
  const stats = db.prepare(`
    SELECT 
      COUNT(*) as total_contacts,
      COUNT(CASE WHEN status = 'active' THEN 1 END) as active_contacts,
      COUNT(CASE WHEN status = 'inactive' THEN 1 END) as inactive_contacts,
      COUNT(CASE WHEN status = 'blocked' THEN 1 END) as blocked_contacts,
      COUNT(CASE WHEN company IS NOT NULL AND company != '' THEN 1 END) as contacts_with_company,
      COUNT(CASE WHEN email IS NOT NULL AND email != '' THEN 1 END) as contacts_with_email
    FROM customers 
    WHERE user_id = ?
  `).get(userId);

  return stats || {
    total_contacts: 0,
    active_contacts: 0,
    inactive_contacts: 0,
    blocked_contacts: 0,
    contacts_with_company: 0,
    contacts_with_email: 0
  };
}

/**
 * Contact Tags Management
 */

export function getContactTags(userId) {
  return db.prepare(`
    SELECT * FROM contact_tags 
    WHERE user_id = ? 
    ORDER BY name ASC
  `).all(userId);
}

export function createContactTag(userId, tagData) {
  const { name, color = '#3B82F6', description } = tagData;
  
  return db.prepare(`
    INSERT INTO contact_tags (user_id, name, color, description, created_at, updated_at)
    VALUES (?, ?, ?, ?, strftime('%s','now'), strftime('%s','now'))
  `).run(userId, name, color, description);
}

export function updateContactTag(userId, tagId, tagData) {
  const { name, color, description } = tagData;
  
  return db.prepare(`
    UPDATE contact_tags 
    SET name = ?, color = ?, description = ?, updated_at = strftime('%s','now')
    WHERE id = ? AND user_id = ?
  `).run(name, color, description, tagId, userId);
}

export function deleteContactTag(userId, tagId) {
  return db.prepare(`
    DELETE FROM contact_tags 
    WHERE id = ? AND user_id = ?
  `).run(tagId, userId);
}

/**
 * Add tag to contact
 */
export function addTagToContact(userId, contactId, tagName) {
  const contact = getContactProfile(userId, contactId);
  if (!contact) return false;

  const tags = contact.tags || [];
  if (!tags.includes(tagName)) {
    tags.push(tagName);
    db.prepare(`
      UPDATE customers 
      SET tags = ?, updated_at = strftime('%s','now')
      WHERE user_id = ? AND contact_id = ?
    `).run(JSON.stringify(tags), userId, contactId);
    return true;
  }
  return false;
}

/**
 * Remove tag from contact
 */
export function removeTagFromContact(userId, contactId, tagName) {
  const contact = getContactProfile(userId, contactId);
  if (!contact) return false;

  const tags = (contact.tags || []).filter(tag => tag !== tagName);
  db.prepare(`
    UPDATE customers 
    SET tags = ?, updated_at = strftime('%s','now')
    WHERE user_id = ? AND contact_id = ?
  `).run(JSON.stringify(tags), userId, contactId);
  return true;
}

/**
 * Record contact interaction
 */
export function recordContactInteraction(userId, contactId, interactionType, interactionData = {}) {
  return db.prepare(`
    INSERT INTO contact_interactions (user_id, contact_id, interaction_type, interaction_data, created_at)
    VALUES (?, ?, ?, ?, strftime('%s','now'))
  `).run(userId, contactId, interactionType, JSON.stringify(interactionData));
}

/**
 * Get contact interaction history
 */
export function getContactInteractions(userId, contactId, limit = 20) {
  const interactions = db.prepare(`
    SELECT * FROM contact_interactions 
    WHERE user_id = ? AND contact_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(userId, contactId, limit);

  return interactions.map(interaction => {
    try {
      interaction.interaction_data = JSON.parse(interaction.interaction_data || '{}');
    } catch (e) {
      interaction.interaction_data = {};
    }
    return interaction;
  });
}

/**
 * Update contact last contacted time and message count
 */
export function updateContactActivity(userId, contactId) {
  // Update last_contacted timestamp
  db.prepare(`
    UPDATE customers 
    SET last_contacted = strftime('%s','now'), updated_at = strftime('%s','now')
    WHERE user_id = ? AND contact_id = ?
  `).run(userId, contactId);

  // Update message count
  const messageCount = db.prepare(`
    SELECT COUNT(*) as count FROM messages 
    WHERE user_id = ? AND (from_id = ? OR to_id = ?)
  `).get(userId, contactId, contactId);

  db.prepare(`
    UPDATE customers 
    SET total_messages = ?, updated_at = strftime('%s','now')
    WHERE user_id = ? AND contact_id = ?
  `).run(messageCount.count, userId, contactId);
}

/**
 * Delete contact profile
 */
export function deleteContactProfile(userId, contactId) {
  return db.prepare(`
    DELETE FROM customers 
    WHERE user_id = ? AND contact_id = ?
  `).run(userId, contactId);
}

/**
 * Export contacts to CSV format
 */
export function exportContactsToCSV(userId, filters = {}) {
  const contacts = getContactsForUser(userId, { ...filters, limit: 10000 });
  
  const headers = [
    'Contact ID', 'Display Name', 'First Name', 'Last Name', 'Email', 
    'Company', 'Job Title', 'Phone', 'Alternative Phone', 'Address', 
    'City', 'State', 'Country', 'Postal Code', 'Website', 'Tags', 
    'Status', 'Source', 'Total Messages', 'Last Contacted', 'Created At'
  ];

  const csvRows = [headers.join(',')];
  
  contacts.forEach(contact => {
    const row = [
      contact.contact_id,
      contact.display_name || '',
      contact.first_name || '',
      contact.last_name || '',
      contact.email || '',
      contact.company || '',
      contact.job_title || '',
      contact.contact_id,
      contact.phone_alternative || '',
      contact.address || '',
      contact.city || '',
      contact.state || '',
      contact.country || '',
      contact.postal_code || '',
      contact.website || '',
      (contact.tags || []).join(';'),
      contact.status || '',
      contact.source || '',
      contact.total_messages || 0,
      contact.last_contacted ? new Date(contact.last_contacted * 1000).toISOString() : '',
      contact.created_at ? new Date(contact.created_at * 1000).toISOString() : ''
    ].map(field => `"${String(field).replace(/"/g, '""')}"`);
    
    csvRows.push(row.join(','));
  });

  return csvRows.join('\n');
}

/**
 * Import contacts from CSV data
 */
export function importContactsFromCSV(userId, csvData, source = 'import') {
  const lines = csvData.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.replace(/"/g, '').trim());
  
  const contacts = [];
  
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',').map(v => v.replace(/"/g, '').trim());
    
    if (values.length !== headers.length) continue;
    
    const contactData = {};
    headers.forEach((header, index) => {
      contactData[header.toLowerCase().replace(/\s+/g, '_')] = values[index];
    });

    // Map CSV headers to our contact fields
    const contactProfile = {
      contact_id: contactData.contact_id || contactData.phone,
      display_name: contactData.display_name,
      first_name: contactData.first_name,
      last_name: contactData.last_name,
      email: contactData.email,
      company: contactData.company,
      job_title: contactData.job_title,
      phone_alternative: contactData.alternative_phone,
      address: contactData.address,
      city: contactData.city,
      state: contactData.state,
      country: contactData.country,
      postal_code: contactData.postal_code,
      website: contactData.website,
      tags: contactData.tags ? contactData.tags.split(';').filter(t => t.trim()) : [],
      status: contactData.status || 'active',
      source: source
    };

    if (contactProfile.contact_id) {
      upsertContactProfile(userId, contactProfile.contact_id, contactProfile);
      contacts.push(contactProfile);
    }
  }
  
  return contacts;
}
