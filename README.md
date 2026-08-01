# VÁ OS

VÁ OS is the internal operating system for VÁ Bar in Reykjavík.

## Phase 1 build

This package contains the working inventory application plus the first unified VÁ OS navigation shell:

- Dashboard
- Inventory
- Recipes
- Suppliers
- Staff
- Shift Planner
- Staff Hub

The Staff, Shift Planner, and Staff Hub screens are now visible foundations ready for their Supabase tables and workflows in the next sprint.

## Deployment

This is currently a static application. Deploy the repository root on Netlify:

- Build command: leave empty
- Publish directory: `.`

## Backend

The app uses Supabase Authentication and PostgreSQL. Never expose a service-role key in `config.js`; use only the browser-safe publishable key and enforce access through Row Level Security.
