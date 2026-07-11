pipeline {
  agent any

  triggers {
    // Localhost Jenkins: poll GitHub every 2 min (webhook needs public URL)
    pollSCM('H/2 * * * *')
  }

  options {
    disableConcurrentBuilds()
    timestamps()
  }

  environment {
    // Override in Jenkins job if paths differ
    DEPLOY_SCRIPT = 'deploy\\deploy.ps1'
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
          powershell -NoProfile -ExecutionPolicy Bypass -File %DEPLOY_SCRIPT%
        '''
      }
    }
  }

  post {
    success {
      echo 'Deploy succeeded'
    }
    failure {
      echo 'Deploy failed — check console log'
    }
  }
}
