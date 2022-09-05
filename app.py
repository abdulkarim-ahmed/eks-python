from flask import Flask
import os

app = Flask(__name__)

@app.route('/')
def hello_world():
    envVar= os.environ.get('IS_PRODUCTION', "didnt get any")
    res = 'Hello ECS! Finally it Works, Yaayy' + str(envVar)
    return res
