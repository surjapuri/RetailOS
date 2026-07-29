from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    DATABASE_URL: str
    REDIS_URL:    str
    SECRET_KEY:   str
    DEBUG:        bool = False
    CORS_ORIGINS: str  = "http://localhost:3000"
    UDAAN_CLIENT_ID:     str = ""
    UDAAN_CLIENT_SECRET: str = ""
    UDAAN_BASE_URL:      str = "https://api.udaan.com/v1"
    JIOMART_API_KEY:     str = ""
    JIOMART_BASE_URL:    str = "https://partner.jiomart.com/api/v1"
    FCM_SERVER_KEY:      str = ""
    class Config:
        env_file = ".env"

settings = Settings()
