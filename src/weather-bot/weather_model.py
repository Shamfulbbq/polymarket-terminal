import requests
import pandas as pd
import numpy as np
from datetime import datetime, timedelta
from sklearn.ensemble import RandomForestRegressor
from sklearn.metrics import mean_absolute_error
from sklearn.model_selection import train_test_split

CITIES = {
    "Seoul (RKSI Incheon)": {"lat": 37.4602, "lon": 126.4407},
    "Shanghai (ZSPD Pudong)": {"lat": 31.1443, "lon": 121.8083},
    "Chongqing (ZUCK Jiangbei)": {"lat": 29.7196, "lon": 106.6416},
    "London (EGLC City Airport)": {"lat": 51.5048, "lon": 0.0495}
}

def fetch_historical_weather(city_name, lat, lon, years=10):
    print(f"Fetching 10 years of HOURLY historical data for {city_name}...")
    end_date = datetime.now() - timedelta(days=2) # Archive api is delayed by ~2 days
    start_date = end_date - timedelta(days=years*365)
    
    url = f"https://archive-api.open-meteo.com/v1/archive?latitude={lat}&longitude={lon}&start_date={start_date.strftime('%Y-%m-%d')}&end_date={end_date.strftime('%Y-%m-%d')}&hourly=temperature_2m,relative_humidity_2m,surface_pressure,cloud_cover&daily=temperature_2m_max&temperature_unit=fahrenheit&timezone=auto"
    
    response = requests.get(url)
    if response.status_code != 200:
        raise Exception(f"Failed to fetch data: {response.text}")
        
    data = response.json()
    
    # 1. Parse Daily Max Temp
    df_daily = pd.DataFrame({
        "date": pd.to_datetime(data["daily"]["time"]),
        "max_temp": data["daily"]["temperature_2m_max"]
    })
    
    # 2. Parse Hourly Data
    df_hourly = pd.DataFrame({
        "time": pd.to_datetime(data["hourly"]["time"]),
        "temp": data["hourly"]["temperature_2m"],
        "humidity": data["hourly"]["relative_humidity_2m"],
        "pressure": data["hourly"]["surface_pressure"],
        "clouds": data["hourly"]["cloud_cover"]
    })
    
    # 3. Extract 8:00 AM, 10:00 AM, and 12:00 PM data
    df_8am = df_hourly[df_hourly["time"].dt.hour == 8].copy()
    df_8am["date"] = df_8am["time"].dt.normalize()
    df_8am = df_8am.rename(columns={
        "temp": "temp_8am",
        "humidity": "humidity_8am",
        "pressure": "pressure_8am",
        "clouds": "clouds_8am"
    }).drop(columns=["time"])
    
    df_10am = df_hourly[df_hourly["time"].dt.hour == 10][["time", "temp"]].copy()
    df_10am["date"] = df_10am["time"].dt.normalize()
    df_10am = df_10am.rename(columns={"temp": "temp_10am"}).drop(columns=["time"])
    
    df_12pm = df_hourly[df_hourly["time"].dt.hour == 12][["time", "temp"]].copy()
    df_12pm["date"] = df_12pm["time"].dt.normalize()
    df_12pm = df_12pm.rename(columns={"temp": "temp_12pm"}).drop(columns=["time"])
    
    # 4. Merge morning data with the daily max target
    df = pd.merge(df_daily, df_8am, on="date", how="inner")
    df = pd.merge(df, df_10am, on="date", how="inner")
    df = pd.merge(df, df_12pm, on="date", how="inner")
    
    df = df.dropna()
    return df

def create_features(df):
    # Create rolling averages (Average of last 7 days) to provide recent context
    df["temp_roll_7"] = df["max_temp"].shift(1).rolling(window=7).mean()
    
    # Calculate the Morning Heat Trajectory (How fast is it heating up?)
    df["heat_trajectory"] = df["temp_12pm"] - df["temp_8am"]
    
    # Extract seasonal data
    df["month"] = df["date"].dt.month
    df["day_of_year"] = df["date"].dt.dayofyear
    
    df["target"] = df["max_temp"]
    
    df = df.dropna()
    return df

def train_and_evaluate(df, city_name):
    print(f"Training Model for {city_name} with Morning Trajectories...")
    df = create_features(df)
    
    # Features (X) and Target (y)
    features = [
        "temp_8am", "temp_10am", "temp_12pm", "heat_trajectory",
        "humidity_8am", "pressure_8am", "clouds_8am", 
        "temp_roll_7", "month", "day_of_year"
    ]
    X = df[features]
    y = df["target"]
    
    split_index = int(len(df) * 0.9) # 90% train, 10% test
    X_train, X_test = X.iloc[:split_index], X.iloc[split_index:]
    y_train, y_test = y.iloc[:split_index], y.iloc[split_index:]
    
    model = RandomForestRegressor(n_estimators=100, random_state=42)
    model.fit(X_train, y_train)
    
    predictions = model.predict(X_test)
    error = mean_absolute_error(y_test, predictions)
    
    print(f"✅ {city_name} Model Trained! Mean Error on Test Set: {error:.2f}°F")
    
    return model

if __name__ == "__main__":
    for city, coords in CITIES.items():
        df = fetch_historical_weather(city, coords["lat"], coords["lon"], years=10)
        model = train_and_evaluate(df, city)
        print("-" * 50)
