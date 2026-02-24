import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { getCurrentUser } from '../utils/accountUtils';
import { MISTAKE_THRESHOLD } from '../audio/Intonation';

export interface PerformanceData {
  id: string;
  scoreName: string;
  timestamp: string;
  csvData: any[];
  tempo: number;
  intonationData: number[];
  durationRatioData?: number[];
  warpingPath?: [number, number][];
}

interface Stats {
  totalPerformances: number;
  averageIntonation: number;
  averageDurationRatio: number,
  flatPercentage: number;
  sharpPercentage: number;
  neutralPercentage: number;
  recentScores: string[];
}

export default function PerformanceStats() {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    loadStats();
  }, []);

  const loadStats = async () => {
    const user = await getCurrentUser();
    if (!user) return;

    const performances = user.performances;
    
    const totalPerformances = performances.length;
    
    let totalIntonation = 0;
    let totalDurationRatio = 0;
    let flatCount = 0;
    let sharpCount = 0;
    let neutralCount = 0;
    let totalNotes = 0;

    performances.forEach(perf => {
      perf.intonationData.forEach(intonation => {
        totalIntonation += Math.abs(intonation);
        totalNotes++;
        
        if (intonation < -MISTAKE_THRESHOLD) flatCount++;
        else if (intonation > MISTAKE_THRESHOLD) sharpCount++;
        else neutralCount++;
      });

      if (perf.durationRatioData) {
        for (let d of perf.durationRatioData) totalDurationRatio += d;
      }
    });

    const averageIntonation = totalNotes > 0 ? totalIntonation / totalNotes : 0;
    const averageDurationRatio = totalDurationRatio > 0? totalDurationRatio / totalNotes : 0;
    const flatPercentage = totalNotes > 0 ? (flatCount / totalNotes) * 100 : 0;
    const sharpPercentage = totalNotes > 0 ? (sharpCount / totalNotes) * 100 : 0;
    const neutralPercentage = totalNotes > 0 ? (neutralCount / totalNotes) * 100 : 0;

    const recentScores = performances
      .slice(-5)
      .reverse()
      .map(p => p.scoreName);

    setStats({
      totalPerformances,
      averageIntonation,
      averageDurationRatio,
      flatPercentage,
      sharpPercentage,
      neutralPercentage,
      recentScores,
    });
  };

  if (!stats) {
    return <Text>Loading statistics...</Text>;
  }

  return (
    <ScrollView style={styles.container}>
      <Text style={styles.title}>Performance Statistics</Text>
      
      <View style={styles.statCard}>
        <Text style={styles.statLabel}>Total Performances</Text>
        <Text style={styles.statValue}>{stats.totalPerformances}</Text>
      </View>

      <View style={styles.statCard}>
        <Text style={styles.statLabel}>Average Intonation Error</Text>
        <Text style={styles.statValue}>{stats.averageIntonation.toFixed(2)} semitones</Text>
      </View>

      <View style={styles.statCard}>
        <Text style={styles.statLabel}>Intonation Distribution</Text>
        <Text style={styles.distributionText}>
          Flat: {stats.flatPercentage.toFixed(1)}%
        </Text>
        <Text style={styles.distributionText}>
          In-tune: {stats.neutralPercentage.toFixed(1)}%
        </Text>
        <Text style={styles.distributionText}>
          Sharp: {stats.sharpPercentage.toFixed(1)}%
        </Text>
      </View>

      <View style={styles.statCard}>
        <Text style={styles.statLabel}>Recent Scores</Text>
        {stats.recentScores.map((score, idx) => (
          <Text key={idx} style={styles.scoreText}>
            {idx + 1}. {score}
          </Text>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 16,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 20,
  },
  statCard: {
    backgroundColor: '#f5f5f5',
    padding: 16,
    borderRadius: 8,
    marginBottom: 16,
  },
  statLabel: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 8,
  },
  statValue: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#2196F3',
  },
  distributionText: {
    fontSize: 14,
    marginVertical: 4,
  },
  scoreText: {
    fontSize: 14,
    marginVertical: 2,
  },
});
