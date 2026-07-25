from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # ---- LLM (OpenAI) ----
    openai_api_key: str = ""
    agent_model: str = "gpt-5.6-terra"    # main sales agent (tool-use / price balance)
    router_model: str = "gpt-5.6-luna"    # cheap intent/format/summaries
    embed_model: str = "text-embedding-3-large"   # 3072 dims
    embed_dim: int = 3072
    # Some reasoning-tier models reject `temperature`; set to -1 to omit it.
    agent_temperature: float = 0.3

    # ---- Pinecone (hot read layer) ----
    pinecone_api_key: str = ""
    pinecone_index: str = "engosoft-courses"
    pinecone_namespace: str = "prod"

    # ---- Odoo 17 (source of truth) ----
    odoo_url: str = "https://engosoft.com"
    odoo_db: str = "EngoSoft"
    odoo_uid: int = 15577
    odoo_api_key: str = ""                         # <- .env, never hardcode
    odoo_course_model: str = "product.template"    # confirm: product.template vs slide.channel
    sales_advisor_id: int = 2                      # Majid (Odoo CRM)

    # ---- Checkout (Odoo eCommerce) ----
    shop_base: str = "https://engosoft.com"

    # ---- Chatwoot (HITL handoff) ----
    chatwoot_url: str = "https://chat.engosoft.com"
    chatwoot_account_id: int = 1
    chatwoot_inbox_id: int = 1
    chatwoot_api_token: str = ""

    # ---- State / memory ----
    # Empty -> in-memory checkpointer (dev only, memory dies with the process).
    database_url: str = ""
    jwt_secret: str = "change-me"
    jwt_ttl_hours: int = 12
    guest_rate_per_min: int = 20          # fixes Fahym's open-endpoint gap
    guest_mint_per_hour: int = 30         # per-IP cap on minting guest tokens

    # ---- CORS ----
    # Comma-separated. Defaults to the shop origin only.
    cors_origins: str = ""

    @property
    def allowed_origins(self) -> list[str]:
        raw = self.cors_origins or self.shop_base
        return [o.strip() for o in raw.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
