pipeline {
  agent any

  // Localhost Jenkins: poll GitHub (webhook needs public URL)
  triggers {
    pollSCM('H/2 * * * *')
  }

  options {
    disableConcurrentBuilds()
    timestamps()
    timeout(time: 45, unit: 'MINUTES')
  }

  environment {
    FRONTEND_DEST = 'C:\\inetpub\\wwwroot\\ai-marketing-frontend'
    BACKEND_DEST  = 'C:\\inetpub\\wwwroot\\ai-marketing-backend'
    API_URL       = 'http://74.208.184.175:5000'
  }

  stages {
    stage('Checkout') {
      steps {
        checkout scm
      }
    }

    stage('Deploy') {
      steps {
        bat '''
          powershell -NoProfile -ExecutionPolicy Bypass -File deploy\\deploy.ps1 -FrontendDest "%FRONTEND_DEST%" -BackendDest "%BACKEND_DEST%" -ApiUrl "%API_URL%"
        '''
      }
    }
  }

  post {
    success {
      echo 'AI Marketing deploy succeeded — check http://74.208.184.175:521'
    }
    failure {
      echo 'Deploy failed — open Console Output for errors'
    }
  }
}
