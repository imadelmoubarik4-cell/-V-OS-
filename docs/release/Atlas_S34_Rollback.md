# Atlas S34 Git-only rollback

S34 has not been applied to a hosted database, deployed as an Edge Function,
published as a preview, or enabled for notification delivery. Its endpoint
configuration is blank and the dispatch candidate defaults to disabled.

The Git-only rollback is therefore one operation: revert the S34 merge commit.
Do not run SQL rollback, delete hosted data, disable a hosted function, or alter
production configuration as part of this rollback note. Those actions would be
outside the approved scope because no corresponding hosted S34 action occurred.

If S34 is later approved and exercised in isolated staging, create a separate
recovery plan from the exact applied migration/function manifest and staging
backup evidence before any rollback action.
