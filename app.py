from flask import Flask, request, jsonify
from flask_cors import CORS
import requests
import os
import math

app = Flask(__name__)
CORS(app)  # Enable CORS for all routes

API_TOKEN = os.environ.get('API_TOKEN', '5844553333:b063s6yM')
API_URL = "https://leakosintapi.com/"

def calculate_cost(limit, query):
    """Calculate request cost based on API documentation"""
    # Count significant words (ignore short strings, dates, etc.)
    words = [word for word in query.split() 
             if len(word) >= 4 and not word.isdigit()]
    
    # Determine complexity
    word_count = len(words)
    if word_count == 1:
        complexity = 1
    elif word_count == 2:
        complexity = 5
    elif word_count == 3:
        complexity = 16
    else:
        complexity = 40
    
    # Calculate cost
    return (5 + math.sqrt(limit * complexity)) / 5000

@app.route('/search', methods=['POST'])
def search():
    data = request.json
    query = data.get('query')
    limit = min(int(data.get('limit', 100)), 10000)  # Enforce max limit
    lang = data.get('lang', 'en')
    
    if not query:
        return jsonify({"error": "Query parameter is required"}), 400
    
    # Calculate cost
    cost = calculate_cost(limit, query)
    
    payload = {
        "token": API_TOKEN,
        "request": query,
        "limit": limit,
        "lang": lang
    }
    
    try:
        response = requests.post(API_URL, json=payload)
        result = response.json()
        
        # Add cost information to response
        if "List" in result:
            result["cost"] = round(cost, 6)
            result["balance_impact"] = f"${result['cost']} will be deducted"
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.environ.get('PORT', 3000)))
