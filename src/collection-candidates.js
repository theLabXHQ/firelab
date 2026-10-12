export const COLLECTION_CANDIDATES = Object.freeze(`
users user profiles profile accounts account members member customers customer
admins admin roles permissions groups teams organizations organisation companies tenants
posts post comments comment replies reactions likes feeds feed timelines stories
articles blogs blog news pages content drafts publications authors tags categories
products product catalog items inventory stock warehouses suppliers brands variants
orders order carts cart checkout checkouts payments payment transactions invoices
subscriptions plans billing receipts refunds discounts coupons promotions prices
settings setting config configuration configurations preferences features flags metadata
public private internal secrets credentials tokens sessions session devices installations
notifications notification messages message chats chat conversations channels inbox outbox
contacts contact friends followers following invitations invites requests connections
files file uploads upload images image photos photo videos video media attachments
folders documents document assets resources downloads storage buckets thumbnails
events event calendars schedules appointments bookings reservations tickets venues locations
courses course lessons lesson students student teachers instructors classes classrooms
assignments submissions grades quizzes questions answers exams enrollments certificates
projects project tasks task boards lists notes note workspaces milestones issues
reports report analytics metrics statistics stats logs log audit audits activities
activity history errors feedback reviews review ratings surveys responses forms
support help faqs announcements banners links redirects urls pages_public userProfiles
user_profiles user_settings userRoles user_roles app_settings appConfig app_config
pushTokens push_tokens fcmTokens fcm_tokens deviceTokens device_tokens accessLogs access_logs
loginHistory login_history purchaseHistory purchase_history orderItems order_items
shipping addresses address deliveries delivery tracking shipments payouts wallets balances
achievements badges scores leaderboard leaderboards games matches players rooms presence
`.trim().split(/\s+/));

export function selectScope({ mode = 'auto', custom = '', known = [] } = {}) {
  if (!['auto', 'discovery', 'custom'].includes(mode)) throw new Error('Choose a supported scan scope.');
  const entered = custom.split(/\r?\n/).map(p => p.trim()).filter(Boolean);
  let paths, source;
  if (mode === 'custom') { paths = entered; source = 'Custom paths only'; }
  else if (mode === 'discovery') { paths = [...entered, ...known, ...COLLECTION_CANDIDATES]; source = 'Common-name candidates plus workspace and custom paths'; }
  else { paths = entered.length ? entered : [...known, ...COLLECTION_CANDIDATES]; source = entered.length ? 'Custom paths' : 'Workspace paths and common-name candidates'; }
  paths = [...new Set(paths.map(p => p.replace(/^\/+|\/+$/g, '')))];
  if (!paths.length || paths.length > 500) throw new Error('Scope must contain 1–500 unique paths.');
  return { paths, source };
}
