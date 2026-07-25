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
    # The bot's Odoo user cannot read training.package*. n8n can, so it PUSHES a
    # snapshot on a schedule instead of the bot pulling through it: no extra hop
    # on the chat path and no admin credential in a public request path.
    ingest_token: str = ""

    # ---- Chatwoot handoff ----
    # Nabras does NOT write to Chatwoot: the bridge owns that conversation
    # state. We only emit a handoff signal on the SSE stream.
    handoff_enabled: bool = True

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
