pipeline {
  agent any

  triggers {
    pollSCM('H/2 * * * *')
  }

  options {
    disableConcurrentBuilds()
    timestamps()
    timeout(time: 45, unit: 'MINUTES')
  }

  stages {
    stage('Checkout') {
      steps {
        checkout scm
      }
    }

    stage('Deploy') {
      steps {
        bat 'powershell -NoProfile -ExecutionPolicy Bypass -File deploy\\jenkins-deploy.ps1'
      }
    }
  }

  post {
    success {
      echo 'Deploy OK — refresh http://74.208.184.175:521 (Ctrl+F5)'
    }
    failure {
      echo 'FAILED — scroll UP in this Console Output for the real error line'
    }
  }
}
