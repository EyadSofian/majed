from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # ---- LLM (OpenAI) ----
    openai_api_key: str = ""
    agent_model: str = "gpt-5.6-terra"    # main sales agent (tool-use / price balance)
    router_model: str = "gpt-5.6-luna"    # cheap intent/format/summaries
    # Some reasoning-tier models reject `temperature`; set to -1 to omit it.
    agent_temperature: float = 0.3
    # gpt-5.x refuses function tools on /v1/chat/completions unless reasoning is
    # switched off, and every turn here carries 9 tools. Empty string = never
    # send the field. See agent.reasoning_effort_for.
    agent_reasoning_effort: str = "none"
    # Odoo profile fields are not consistently translated. When the visitor is
    # using Arabic, translate the trainer's customer-facing title, biography,
    # specialisations and experience without changing names, facts or
    # credentials. Results are cached in-process, so a profile is translated
    # only once per source revision.
    profile_translation_enabled: bool = True
    profile_translation_timeout: float = 12.0
    profile_translation_cache_size: int = 256

    # ---- Odoo 17 ----
    odoo_url: str = "https://engosoft.com"
    odoo_db: str = "EngoSoft"
    odoo_uid: int = 15577
    odoo_api_key: str = ""                         # <- .env, never hardcode
    odoo_timeout: float = 20.0
    # The shop renders Arabic; the bot's Odoo user reads English. Course names
    # are re-read in this language so the chat calls a course what the page
    # calls it. Empty = keep whatever the API user's language returns.
    odoo_lang: str = "ar_001"

    # Courses are product.template rows of this type (custom Engosoft type).
    course_product_type: str = "course"
    sales_advisor_id: int = 2                      # Majid (Odoo CRM)

    # ---- SLA: a lead has to enter the advisor's follow-up cycle ----
    # The Digital Sales SLA runs off Odoo activities: the advisor works
    # "Activity Today", then "Overdue Activities". A lead with no activity on it
    # appears in neither, so it is assigned to a human and then silently waits.
    # Majed's leads used to be exactly that.
    lead_activity_enabled: bool = True
    # 0 = due today, which is where the SLA wants a fresh website lead: the
    # advisor's first call is the same day it arrives.
    lead_activity_delay_days: int = 0
    lead_activity_summary: str = "مكالمة أولى — عميل من ماجد"
    # Standard Odoo activity type. Falls back to any available type if this
    # database renamed or removed it, because a lead with *some* activity is
    # still in the cycle, and one with none is not.
    lead_activity_type_xmlid: str = "mail.mail_activity_data_call"
    # utm.source, so Majed's leads are a countable bucket next to the SLA's
    # own three (Unpaid · AbanteCart · Signup) instead of being unattributable.
    lead_source_name: str = "ماجد — شات الموقع"

    # ---- Catalogue cache ----
    # The whole sellable catalogue is ~75 rows, so it lives in memory and is
    # refreshed by polling write_date. No vector DB needed at this size.
    catalog_refresh_seconds: int = 300
    events_horizon_days: int = 240

    # ---- Pricing ----
    # website-linked pricelists discovered in Odoo: currency -> pricelist id
    pricelist_egp: int = 28
    pricelist_usd: int = 27
    pricelist_aed: int = 29
    pricelist_sar: int = 9
    default_currency: str = "EGP"

    # ---- Checkout ----
    shop_base: str = "https://engosoft.com"

    # ---- Safety while trialling on demo ----
    # Reads always come from the production catalogue — that is where the data
    # lives. Writes must not: a trial conversation would otherwise create real
    # CRM leads. Set false while testing on demo.engosoft.com.
    allow_crm_writes: bool = True

    # ---- Package ingest (n8n push) ----
    # Odoo is the primary package source. Keep n8n ingest configured as a
    # recoverable fallback for an Odoo permission regression or outage.
    ingest_token: str = ""
    # A scheduled push is fine for a catalogue that changes daily, but a
    # customer asking about a track NOW should not be answered from a snapshot
    # taken 19 minutes ago — or from nothing at all after a restart. When this
    # webhook is set, it is called only after a direct Odoo refresh fails.
    packages_webhook_url: str = ""
    packages_max_age_seconds: int = 600
    packages_fetch_timeout: float = 12.0

    # ---- Chatwoot handoff ----
    # Nabras does NOT write to Chatwoot: the bridge owns that conversation
    # state. We only emit a handoff signal on the SSE stream.
    handoff_enabled: bool = True

    # ---- Deep course details routing ----
    # The funnel: Nabras qualifies, offers a package/track with a SHORT pitch,
    # and closes. When a visitor asks for the DEEP details of one course (full
    # syllabus, page link, reviews), this decides who answers:
    #   False (default) -> Nabras answers with get_course_details. Fully working
    #                      today, one brain owns everything.
    #   True            -> Nabras calls defer_to_bot("course_details") and the
    #                      bridge lets Botpress answer that same message from its
    #                      course knowledge base. Only turn this on once Botpress
    #                      is configured to answer course-detail questions, or the
    #                      visitor gets nothing when Botpress is not set up.
    details_to_botpress: bool = False

    # ---- State / memory ----
    # Empty -> in-memory checkpointer (dev only, memory dies with the process).
    database_url: str = ""
    jwt_secret: str = "change-me"
    jwt_ttl_hours: int = 12
    guest_rate_per_min: int = 20
    guest_mint_per_hour: int = 30

    # ---- CORS ----
    cors_origins: str = ""

    @property
    def allowed_origins(self) -> list[str]:
        raw = self.cors_origins or self.shop_base
        return [o.strip() for o in raw.split(",") if o.strip()]

    def pricelist_for(self, currency: str) -> int:
        return {
            "EGP": self.pricelist_egp, "USD": self.pricelist_usd,
            "AED": self.pricelist_aed, "SAR": self.pricelist_sar,
        }.get((currency or self.default_currency).upper(), self.pricelist_egp)

    @property
    def supported_currencies(self) -> list[str]:
        return ["EGP", "USD", "AED", "SAR"]


@lru_cache
def get_settings() -> Settings:
    return Settings()
